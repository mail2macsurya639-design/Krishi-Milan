"""
Krishi Milan (कृषि मिलन) — backend API
Farmer <-> Buyer direct marketplace, powered by a region-aware crop
recommendation model + Google Gemini API.

Run:
    pip install -r requirements.txt --break-system-packages
    cp .env.example .env   # fill in real values
    python app.py
"""

import os
import json
import datetime
import secrets
from functools import wraps

import certifi
import jwt
import joblib
import pandas as pd
import requests
from flask import Flask, request, jsonify
from flask_cors import CORS
from pymongo import MongoClient
from pymongo.errors import PyMongoError
from bson import ObjectId
from bson.errors import InvalidId
from werkzeug.security import generate_password_hash, check_password_hash
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
CORS(app)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
MONGO_URI = os.getenv("MONGO_URI", "")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
WEATHER_API_KEY = os.getenv("WEATHER_API_KEY", "")
JWT_SECRET = os.getenv("JWT_SECRET", "")
JWT_ALGO = "HS256"

if not MONGO_URI:
    raise RuntimeError("MONGO_URI missing — set it in .env (never hardcode it)")
if not JWT_SECRET:
    raise RuntimeError(
        "JWT_SECRET missing — set it in .env to any long random string "
        "(e.g. run: python -c \"import secrets; print(secrets.token_hex(32))\")"
    )

# tlsCAFile=certifi.where() fixes the common macOS python.org install issue
# where pymongo can't find the local CA bundle (CERTIFICATE_VERIFY_FAILED).
mongo_client = MongoClient(MONGO_URI, tlsCAFile=certifi.where())
db = mongo_client["krishi_milan"]
users_col = db["users"]
listings_col = db["listings"]
matches_col = db["matches"]
predictions_col = db["predictions"]

# ---------------------------------------------------------------------------
# ML model (existing artifacts — unchanged)
# ---------------------------------------------------------------------------
MODEL = joblib.load("ensemble_model.pkl")
ENCODER = joblib.load("label_encoder.pkl")
FEATURES = joblib.load("features.pkl")

# Rough agro-climatic bounds per Nepal region, used only to sanity-check /
# nudge the model's output. Replace with real Nepal agri data over time —
# this is a stated future-scope item, not a claim of full retraining.
REGION_PROFILE = {
    "terai": {"temperature": (20, 40), "rainfall": (1000, 2500), "label_ne": "तराई"},
    "pahad": {"temperature": (10, 28), "rainfall": (800, 2000), "label_ne": "पहाड"},
    "himal": {"temperature": (-5, 18), "rainfall": (250, 1200), "label_ne": "हिमाल"},
}

CROPS_UNLIKELY_IN_HIMAL = {"rice", "jute", "coconut", "papaya", "banana"}


def region_adjusted_prediction(input_df, region):
    """Get top-3 predictions from the model, softly re-ranked by region."""
    probs = MODEL.predict_proba(input_df)[0]
    classes = ENCODER.inverse_transform(range(len(probs)))
    ranked = sorted(zip(classes, probs), key=lambda x: x[1], reverse=True)

    if region == "himal":
        ranked = [r for r in ranked if r[0].lower() not in CROPS_UNLIKELY_IN_HIMAL] + \
                 [r for r in ranked if r[0].lower() in CROPS_UNLIKELY_IN_HIMAL]

    top3 = ranked[:3]
    return [{"crop": c, "confidence": round(float(p) * 100, 2)} for c, p in top3]


# ---------------------------------------------------------------------------
# Gemini helper (plain REST call — no extra SDK dependency)
# ---------------------------------------------------------------------------
def call_gemini(prompt, lang="ne"):
    if not GEMINI_API_KEY:
        return None  # caller falls back to a plain response without AI text

    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"
    )
    lang_instruction = "Reply in Nepali." if lang == "ne" else "Reply in English."
    body = {
        "contents": [{"parts": [{"text": f"{lang_instruction}\n\n{prompt}"}]}]
    }
    try:
        resp = requests.post(url, json=body, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        return data["candidates"][0]["content"]["parts"][0]["text"]
    except Exception as e:
        print("Gemini call failed:", e)
        return None


def call_gemini_chat(history, lang="ne"):
    """history is a list of {role: 'user'|'model', text: str}, oldest first."""
    if not GEMINI_API_KEY:
        return None
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"
    )
    lang_instruction = "Always reply in Nepali." if lang == "ne" else "Always reply in English."
    system_note = (
        f"{lang_instruction} You are a friendly farming assistant for Nepali "
        f"farmers (Terai, Pahad, Himal regions). Keep answers short, practical, "
        f"and easy to understand. If a question needs a local expert (e.g. "
        f"disease diagnosis needing a lab test), say so honestly."
    )
    contents = [{"role": "user", "parts": [{"text": system_note}]}]
    contents.append({"role": "model", "parts": [{"text": "ठीक छ, म तयार छु।" if lang == "ne" else "Understood, ready to help."}]})
    for turn in history:
        role = "user" if turn.get("role") == "user" else "model"
        contents.append({"role": role, "parts": [{"text": turn.get("text", "")}]})

    try:
        resp = requests.post(url, json={"contents": contents}, timeout=20)
        resp.raise_for_status()
        data = resp.json()
        return data["candidates"][0]["content"]["parts"][0]["text"]
    except Exception as e:
        print("Gemini chat call failed:", e)
        return None


def call_gemini_vision(prompt, image_b64, mime_type, lang="ne"):
    if not GEMINI_API_KEY:
        return None
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"
    )
    lang_instruction = "Reply in Nepali." if lang == "ne" else "Reply in English."
    body = {
        "contents": [{
            "parts": [
                {"text": f"{lang_instruction}\n\n{prompt}"},
                {"inline_data": {"mime_type": mime_type, "data": image_b64}},
            ]
        }]
    }
    try:
        resp = requests.post(url, json=body, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        return data["candidates"][0]["content"]["parts"][0]["text"]
    except Exception as e:
        print("Gemini vision call failed:", e)
        return None


# ---------------------------------------------------------------------------
# Weather helper (OpenWeatherMap)
# ---------------------------------------------------------------------------
def get_weather(lat, lon):
    if not WEATHER_API_KEY:
        return None
    url = "https://api.openweathermap.org/data/2.5/weather"
    params = {"lat": lat, "lon": lon, "appid": WEATHER_API_KEY, "units": "metric"}
    try:
        resp = requests.get(url, params=params, timeout=10)
        resp.raise_for_status()
        d = resp.json()
        return {
            "temperature": d["main"]["temp"],
            "humidity": d["main"]["humidity"],
            "description": d["weather"][0]["description"],
        }
    except Exception as e:
        print("Weather call failed:", e)
        return None


def serialize(doc):
    """Recursively convert ObjectId and datetime fields to JSON-safe types.
    Needed because farmer_id, listing_id, etc. are raw ObjectId — Flask's
    default JSON encoder can't serialize those, which was silently breaking
    /api/listings and /api/match responses."""
    if isinstance(doc, ObjectId):
        return str(doc)
    if isinstance(doc, datetime.datetime):
        return doc.isoformat()
    if isinstance(doc, dict):
        return {k: serialize(v) for k, v in doc.items()}
    if isinstance(doc, list):
        return [serialize(v) for v in doc]
    return doc


def valid_object_id(id_str):
    try:
        return ObjectId(id_str)
    except InvalidId:
        return None


# ---------------------------------------------------------------------------
# JWT auth — issued at register/login, sent as "Authorization: Bearer <token>".
# We derive user identity from the token server-side instead of trusting
# whatever farmer_id/buyer_id the client sends — otherwise anyone could post
# a listing under someone else's name.
# ---------------------------------------------------------------------------
def generate_token(user_id, role):
    payload = {
        "user_id": str(user_id),
        "role": role,
        "exp": datetime.datetime.utcnow() + datetime.timedelta(days=14),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)


def get_auth_user():
    """Returns {"user_id": ..., "role": ...} if a valid bearer token is
    present, else None. Never raises — callers decide what to do with None."""
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return None
    token = auth_header.split(" ", 1)[1]
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
    except jwt.PyJWTError:
        return None


def require_auth(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        auth_user = get_auth_user()
        if not auth_user:
            return jsonify({"error": "Authentication required — please log in again"}), 401
        request.auth_user = auth_user
        return f(*args, **kwargs)
    return wrapper


# ---------------------------------------------------------------------------
# Global error handling — never let a raw HTML error page reach the frontend
# ---------------------------------------------------------------------------
@app.errorhandler(PyMongoError)
def handle_mongo_error(e):
    print("MongoDB error:", e)
    return jsonify({"error": "Database connection failed. Check MONGO_URI, network access (IP whitelist in Atlas), and SSL certificates."}), 503


@app.errorhandler(Exception)
def handle_any_error(e):
    print("Unhandled error:", e)
    return jsonify({"error": str(e)}), 500


# ---------------------------------------------------------------------------
# Auth routes
# ---------------------------------------------------------------------------
OTP_EXPIRY_MINUTES = 5
otps_col = db["otps"]


def generate_otp():
    return f"{secrets.randbelow(1_000_000):06d}"


@app.route("/api/register/send-otp", methods=["POST"])
def send_otp():
    data = request.get_json(force=True)
    phone = data.get("phone")
    if not phone:
        return jsonify({"error": "phone is required"}), 400
    if users_col.find_one({"phone": phone}):
        return jsonify({"error": "Phone number already registered"}), 409

    otp = generate_otp()
    otps_col.update_one(
        {"phone": phone},
        {"$set": {
            "otp_hash": generate_password_hash(otp),
            "expires_at": datetime.datetime.utcnow() + datetime.timedelta(minutes=OTP_EXPIRY_MINUTES),
            "created_at": datetime.datetime.utcnow(),
        }},
        upsert=True,
    )

    # No real SMS gateway is wired in (Twilio / Sparrow SMS etc. cost money
    # and need business verification — out of scope for this demo). In demo
    # mode we return the OTP directly so the flow can be shown end-to-end;
    # swap this block for a real SMS/email send in production.
    return jsonify({
        "sent": True,
        "demo_mode": True,
        "demo_otp": otp,
        "expires_in_minutes": OTP_EXPIRY_MINUTES,
        "note": "Demo mode: no real SMS provider connected, OTP returned directly for testing.",
    })


@app.route("/api/register", methods=["POST"])
def register():
    data = request.get_json(force=True)
    required = ["name", "phone", "password", "role", "region", "otp"]
    missing = [f for f in required if not data.get(f)]
    if missing:
        return jsonify({"error": f"Missing fields: {', '.join(missing)}"}), 400

    if data["role"] not in ("farmer", "buyer"):
        return jsonify({"error": "role must be 'farmer' or 'buyer'"}), 400
    if data["region"] not in REGION_PROFILE:
        return jsonify({"error": "region must be terai, pahad, or himal"}), 400

    if users_col.find_one({"phone": data["phone"]}):
        return jsonify({"error": "Phone number already registered"}), 409

    otp_record = otps_col.find_one({"phone": data["phone"]})
    if not otp_record:
        return jsonify({"error": "No OTP was requested for this phone. Please request one first."}), 400
    if otp_record["expires_at"] < datetime.datetime.utcnow():
        otps_col.delete_one({"_id": otp_record["_id"]})
        return jsonify({"error": "OTP expired. Please request a new one."}), 400
    if not check_password_hash(otp_record["otp_hash"], data["otp"]):
        return jsonify({"error": "Incorrect OTP."}), 400

    otps_col.delete_one({"_id": otp_record["_id"]})  # OTP is single-use

    user = {
        "name": data["name"],
        "phone": data["phone"],
        "password_hash": generate_password_hash(data["password"]),
        "role": data["role"],
        "region": data["region"],
        "language_pref": data.get("language_pref", "ne"),
        "created_at": datetime.datetime.utcnow(),
    }
    result = users_col.insert_one(user)
    user["_id"] = result.inserted_id
    del user["password_hash"]
    token = generate_token(user["_id"], user["role"])
    return jsonify({**serialize(user), "token": token}), 201


@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json(force=True)
    phone = data.get("phone")
    password = data.get("password")
    user = users_col.find_one({"phone": phone})
    if not user or not check_password_hash(user["password_hash"], password or ""):
        return jsonify({"error": "Invalid phone or password"}), 401
    del user["password_hash"]
    token = generate_token(user["_id"], user["role"])
    return jsonify({**serialize(user), "token": token}), 200


# ---------------------------------------------------------------------------
# Prediction route (region-aware, Gemini-explained)
# ---------------------------------------------------------------------------
@app.route("/api/predict", methods=["POST"])
def predict():
    data = request.get_json(force=True)
    region = data.get("region")
    if region not in REGION_PROFILE:
        return jsonify({"error": "region must be terai, pahad, or himal"}), 400

    try:
        input_df = pd.DataFrame([[
            float(data.get("N", 0)),
            float(data.get("P", 0)),
            float(data.get("K", 0)),
            float(data.get("temperature", 0)),
            float(data.get("humidity", 0)),
            float(data.get("ph", 0)),
            float(data.get("rainfall", 0)),
        ]], columns=FEATURES)
    except (TypeError, ValueError):
        return jsonify({"error": "N, P, K, temperature, humidity, ph, rainfall must be numbers"}), 400

    top3 = region_adjusted_prediction(input_df, region)

    lang = data.get("lang", "ne")
    explanation = None
    if top3:
        prompt = (
            f"A farmer in the {region} region of Nepal got these crop "
            f"recommendations with confidence scores: {top3}. "
            f"Write a short, spoken-friendly explanation in 4-5 short "
            f"sentences total: (1) why the top crop ({top3[0]['crop']}) fits "
            f"this region, (2) 2-3 quick practical facts about growing it — "
            f"e.g. typical growing duration, water needs, and one care tip — "
            f"(3) what the farmer should prepare next. Keep sentences short "
            f"and simple since this will be read aloud to a farmer."
        )
        explanation = call_gemini(prompt, lang)

    farmer_id = None
    auth_user = get_auth_user()
    if auth_user:
        farmer_id = auth_user["user_id"]
    if farmer_id and valid_object_id(farmer_id):
        predictions_col.insert_one({
            "farmer_id": ObjectId(farmer_id),
            "input": data,
            "top3": top3,
            "created_at": datetime.datetime.utcnow(),
        })

    return jsonify({
        "region": region,
        "top3": top3,
        "explanation": explanation,
    })


# ---------------------------------------------------------------------------
# Weather route
# ---------------------------------------------------------------------------
@app.route("/api/weather", methods=["GET"])
def weather():
    lat = request.args.get("lat")
    lon = request.args.get("lon")
    if not lat or not lon:
        return jsonify({"error": "lat and lon query params required"}), 400
    result = get_weather(lat, lon)
    if result is None:
        return jsonify({"error": "Weather service unavailable"}), 503
    return jsonify(result)


# ---------------------------------------------------------------------------
# Prediction history (for the logged-in farmer)
# ---------------------------------------------------------------------------
@app.route("/api/predictions", methods=["GET"])
@require_auth
def prediction_history():
    farmer_id = ObjectId(request.auth_user["user_id"])
    docs = predictions_col.find({"farmer_id": farmer_id}).sort("created_at", -1).limit(50)
    return jsonify([serialize(d) for d in docs])


# ---------------------------------------------------------------------------
# Listings (marketplace)
# ---------------------------------------------------------------------------
@app.route("/api/listings", methods=["GET", "POST"])
def listings():
    if request.method == "POST":
        auth_user = get_auth_user()
        if not auth_user:
            return jsonify({"error": "Authentication required — please log in again"}), 401
        if auth_user["role"] != "farmer":
            return jsonify({"error": "Only farmer accounts can post listings"}), 403

        data = request.get_json(force=True)
        required = ["crop_name", "quantity", "unit", "price_expected", "region"]
        missing = [f for f in required if data.get(f) in (None, "")]
        if missing:
            return jsonify({"error": f"Missing fields: {', '.join(missing)}"}), 400

        listing = {
            "farmer_id": ObjectId(auth_user["user_id"]),
            "crop_name": data["crop_name"],
            "quantity": float(data["quantity"]),
            "unit": data["unit"],
            "price_expected": float(data["price_expected"]),
            "region": data["region"],
            "status": "open",
            "created_at": datetime.datetime.utcnow(),
        }
        result = listings_col.insert_one(listing)
        listing["_id"] = result.inserted_id
        return jsonify(serialize(listing)), 201

    # GET — optional filters
    query = {"status": "open"}
    region = request.args.get("region")
    crop = request.args.get("crop")
    if region:
        query["region"] = region
    if crop:
        query["crop_name"] = {"$regex": crop, "$options": "i"}

    results = [serialize(l) for l in listings_col.find(query).sort("created_at", -1)]
    return jsonify(results)


# ---------------------------------------------------------------------------
# Matching (buyer describes need in plain language -> Gemini finds a fit)
# ---------------------------------------------------------------------------
@app.route("/api/match", methods=["POST"])
def match():
    data = request.get_json(force=True)
    need_text = data.get("need_text")
    lang = data.get("lang", "ne")

    if not need_text:
        return jsonify({"error": "need_text is required"}), 400

    auth_user = get_auth_user()
    if auth_user:
        buyer_oid = ObjectId(auth_user["user_id"])
    else:
        buyer_id = data.get("buyer_id")
        buyer_oid = valid_object_id(buyer_id) if buyer_id else None
    open_listings = list(listings_col.find({"status": "open"}).limit(30))
    if not open_listings:
        return jsonify({"matches": [], "note": "No open listings yet"}), 200

    listing_summaries = [
        {
            "id": str(l["_id"]),
            "crop": l["crop_name"],
            "quantity": l["quantity"],
            "unit": l["unit"],
            "price_expected": l["price_expected"],
            "region": l["region"],
        }
        for l in open_listings
    ]

    prompt = (
        f"A buyer needs: \"{need_text}\". Here are available listings (JSON): "
        f"{json.dumps(listing_summaries)}. "
        f"Return ONLY a JSON array of the best-fit listing ids, ranked best "
        f"first, max 3 items, no explanation, e.g. [\"id1\", \"id2\"]."
    )
    raw = call_gemini(prompt, lang="en")  # keep matching logic in English, explain in local lang later
    matched_ids = []
    if raw:
        try:
            cleaned = raw.strip().strip("`").replace("json", "", 1).strip()
            matched_ids = json.loads(cleaned)
        except Exception:
            matched_ids = [listing_summaries[0]["id"]] if listing_summaries else []
    else:
        matched_ids = [l["id"] for l in listing_summaries[:3]]

    matched_listings = [serialize(l) for l in open_listings if str(l["_id"]) in matched_ids]

    deal_summary = None
    if matched_listings:
        summary_prompt = (
            f"Write a short, friendly 2-sentence deal summary in {'Nepali' if lang=='ne' else 'English'} "
            f"connecting a buyer who needs \"{need_text}\" with this listing: {matched_listings[0]}."
        )
        deal_summary = call_gemini(summary_prompt, lang)

    if buyer_oid and matched_listings:
        matches_col.insert_one({
            "listing_id": ObjectId(matched_listings[0]["_id"]),
            "buyer_id": buyer_oid,
            "deal_summary": deal_summary,
            "status": "pending",
            "created_at": datetime.datetime.utcnow(),
        })

    return jsonify({"matches": matched_listings, "deal_summary": deal_summary})


# ---------------------------------------------------------------------------
# Deal status — Pending -> Confirmed -> Completed (or Rejected)
# ---------------------------------------------------------------------------
DEAL_STATUSES = ("pending", "confirmed", "completed", "rejected")


@app.route("/api/matches", methods=["GET"])
@require_auth
def my_matches():
    uid = ObjectId(request.auth_user["user_id"])
    role = request.auth_user["role"]

    if role == "buyer":
        docs = list(matches_col.find({"buyer_id": uid}).sort("created_at", -1))
    else:
        my_listing_ids = [l["_id"] for l in listings_col.find({"farmer_id": uid}, {"_id": 1})]
        docs = list(matches_col.find({"listing_id": {"$in": my_listing_ids}}).sort("created_at", -1))

    # Attach a short listing summary to each match so the UI doesn't need a
    # second round trip.
    listing_ids = list({d["listing_id"] for d in docs})
    listings_by_id = {
        l["_id"]: l for l in listings_col.find({"_id": {"$in": listing_ids}})
    } if listing_ids else {}

    enriched = []
    for d in docs:
        d = dict(d)
        l = listings_by_id.get(d.get("listing_id"))
        if l:
            d["listing_summary"] = {
                "crop_name": l["crop_name"],
                "quantity": l["quantity"],
                "unit": l["unit"],
                "price_expected": l["price_expected"],
                "region": l["region"],
            }
        enriched.append(d)

    return jsonify([serialize(d) for d in enriched])


@app.route("/api/matches/<match_id>/status", methods=["PATCH"])
@require_auth
def update_match_status(match_id):
    oid = valid_object_id(match_id)
    if not oid:
        return jsonify({"error": "Invalid match id"}), 400

    data = request.get_json(force=True)
    new_status = data.get("status")
    if new_status not in DEAL_STATUSES:
        return jsonify({"error": f"status must be one of {DEAL_STATUSES}"}), 400

    m = matches_col.find_one({"_id": oid})
    if not m:
        return jsonify({"error": "Match not found"}), 404

    uid = ObjectId(request.auth_user["user_id"])
    listing = listings_col.find_one({"_id": m["listing_id"]})
    is_buyer = m.get("buyer_id") == uid
    is_farmer = listing and listing.get("farmer_id") == uid
    if not (is_buyer or is_farmer):
        return jsonify({"error": "You are not part of this deal"}), 403

    matches_col.update_one({"_id": oid}, {"$set": {"status": new_status}})
    updated = matches_col.find_one({"_id": oid})
    return jsonify(serialize(updated))


# ---------------------------------------------------------------------------
# Farming Q&A chatbot
# ---------------------------------------------------------------------------
@app.route("/api/chat", methods=["POST"])
def chat():
    data = request.get_json(force=True)
    history = data.get("history", [])
    lang = data.get("lang", "ne")

    if not history or history[-1].get("role") != "user":
        return jsonify({"error": "history must end with a user message"}), 400
    if len(history) > 20:
        history = history[-20:]  # keep the request small

    reply = call_gemini_chat(history, lang)
    if reply is None:
        return jsonify({
            "error": "Chat assistant unavailable — check GEMINI_API_KEY in .env"
        }), 503

    return jsonify({"reply": reply})


# ---------------------------------------------------------------------------
# Photo-based crop health check (Gemini multimodal)
# ---------------------------------------------------------------------------
@app.route("/api/crop-health", methods=["POST"])
def crop_health():
    data = request.get_json(force=True)
    image_b64 = data.get("image_base64", "")
    crop_name = data.get("crop_name", "")
    lang = data.get("lang", "ne")

    if not image_b64:
        return jsonify({"error": "image_base64 is required"}), 400

    # Accept a raw base64 string or a data: URL — strip the prefix if present.
    mime_type = "image/jpeg"
    if image_b64.startswith("data:"):
        header, image_b64 = image_b64.split(",", 1)
        mime_type = header.split(";")[0].replace("data:", "") or mime_type

    # Rough size guard — Gemini inline images should stay well under ~15MB;
    # base64 is ~1.37x the raw byte size.
    if len(image_b64) > 15_000_000:
        return jsonify({"error": "Image too large — please use a smaller photo"}), 400

    crop_context = f" The farmer says this is a {crop_name} plant." if crop_name else ""
    prompt = (
        "Look at this farm/crop photo. In 3-4 short sentences: (1) name the "
        "most likely issue you see, if any (pest, disease, nutrient "
        "deficiency, or healthy), (2) give one practical next step the "
        "farmer can take. Be honest if you're not confident from the photo "
        "alone and suggest consulting a local agriculture office for lab "
        "confirmation." + crop_context
    )
    result = call_gemini_vision(prompt, image_b64, mime_type, lang)
    if result is None:
        return jsonify({
            "error": "Crop health check unavailable — check GEMINI_API_KEY in .env"
        }), 503

    return jsonify({"analysis": result})


# ---------------------------------------------------------------------------
# Price negotiation coach
# ---------------------------------------------------------------------------
@app.route("/api/negotiate", methods=["POST"])
def negotiate():
    data = request.get_json(force=True)
    listing_id = data.get("listing_id")
    offer_price = data.get("offer_price")
    lang = data.get("lang", "ne")

    oid = valid_object_id(listing_id) if listing_id else None
    if not oid:
        return jsonify({"error": "valid listing_id is required"}), 400
    if offer_price in (None, ""):
        return jsonify({"error": "offer_price is required"}), 400

    listing = listings_col.find_one({"_id": oid})
    if not listing:
        return jsonify({"error": "listing not found"}), 404

    try:
        offer_price = float(offer_price)
    except (TypeError, ValueError):
        return jsonify({"error": "offer_price must be a number"}), 400

    asking_price = listing["price_expected"]
    prompt = (
        f"A farmer is asking {asking_price} per {listing['unit']} for "
        f"{listing['quantity']} {listing['unit']} of {listing['crop_name']} "
        f"in the {listing['region']} region of Nepal. A buyer has offered "
        f"{offer_price} per {listing['unit']} instead. "
        f"NOTE: you do not have live market price data, so do not invent a "
        f"specific 'real' market price. Instead: (1) state plainly that you "
        f"don't have live mandi price data, (2) describe the gap between "
        f"the two numbers in relative terms (e.g. offer is X% below asking), "
        f"(3) suggest a fair, neutral way to bridge it (e.g. meeting near the "
        f"midpoint, or adjusting for quality/delivery), in 3-4 short "
        f"sentences aimed at helping both sides agree calmly."
    )
    coaching = call_gemini(prompt, lang)
    if coaching is None:
        return jsonify({
            "error": "Negotiation coach unavailable — check GEMINI_API_KEY in .env"
        }), 503

    return jsonify({
        "asking_price": asking_price,
        "offer_price": offer_price,
        "unit": listing["unit"],
        "coaching": coaching,
    })


# ---------------------------------------------------------------------------
# Region metadata — used by the frontend to auto-fill a *typical* rainfall
# value when a region is picked. We deliberately don't auto-fill rainfall
# from the live weather API: OpenWeatherMap's "current rain" is near-zero
# except while it's actively raining, but the crop model expects a
# seasonal/typical rainfall figure — filling one with the other would be
# misleading. This is a stated approximation, not real climatological data.
# ---------------------------------------------------------------------------
@app.route("/api/regions", methods=["GET"])
def regions():
    out = {}
    for key, profile in REGION_PROFILE.items():
        temp_lo, temp_hi = profile["temperature"]
        rain_lo, rain_hi = profile["rainfall"]
        out[key] = {
            "label_ne": profile["label_ne"],
            "typical_temperature": round((temp_lo + temp_hi) / 2, 1),
            "typical_rainfall": round((rain_lo + rain_hi) / 2, 1),
            "temperature_range": [temp_lo, temp_hi],
            "rainfall_range": [rain_lo, rain_hi],
        }
    return jsonify(out)


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------
@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "model_loaded": MODEL is not None,
        "gemini_configured": bool(GEMINI_API_KEY),
        "weather_configured": bool(WEATHER_API_KEY),
    })


if __name__ == "__main__":
    app.run(debug=False, port=5000)