# StockBridge — AI-Powered Inventory Management Platform

A full-stack inventory management system built for retail shop owners. Features real-time stock tracking, automated supplier reordering via WhatsApp, POS integration, and an AI depletion forecast engine.

## Features

- **Secure Authentication** — Email + password login with admin approval workflow
- **Inventory Management** — Add, track, and update products with SKU barcodes
- **Supplier Network** — Manage supplier contacts with one-click WhatsApp reordering
- **Live POS Integration** — External cash registers auto-deduct stock via Webhook API
- **AI Forecast Engine** — Linear Regression depletion predictions + IsolationForest anomaly detection
- **Zero-Click Automation** — Background engine monitors low stock and triggers supplier alerts
- **CSV Export** — One-click inventory export to Excel

## Tech Stack

- **Backend:** Node.js, Express.js
- **Database:** SQLite (via sqlite3)
- **Auth:** JWT + bcrypt
- **AI/ML Layer:** Python, FastAPI, scikit-learn, numpy, pandas
- **Frontend:** Vanilla HTML/CSS/JS, Chart.js

## Run Locally

```bash
# Install dependencies
npm install

# Start the server
node server.js
```

App runs at: `http://localhost:3000`

## Run AI Engine (Optional)

```bash
cd ml_service
pip install -r requirements.txt
uvicorn main:app --port 8000 --reload
```

AI endpoints at: `http://localhost:8000`

## Deploy on Railway

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select this repo — Railway auto-detects Node.js and runs `npm start`
4. Get your live URL in ~2 minutes

## Default Admin Setup

1. Open `http://your-app-url/admin.html`
2. View all user signups and approve them
3. Approved users can then set their password and log in

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | 3000 | Server port |
| `JWT_SECRET` | hardcoded | Change this in production |

---

Built for small retail businesses to eliminate manual stock tracking.
