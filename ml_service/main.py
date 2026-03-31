from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from forecaster import run_forecast
from anomaly import run_anomaly_detection

app = FastAPI(title="StockBridge AI Engine", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def root():
    return {"status": "StockBridge AI Engine running", "version": "1.0.0"}


@app.get("/forecast")
def forecast():
    try:
        results = run_forecast()
        return {"status": "success", "count": len(results), "predictions": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/anomalies")
def anomalies():
    try:
        results = run_anomaly_detection()
        flagged = [r for r in results if r["is_anomaly"]]
        return {
            "status": "success",
            "total_products": len(results),
            "anomalies_found": len(flagged),
            "results": results
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/restock-plan")
def restock_plan():
    try:
        forecasts = run_forecast()
        urgent = [f for f in forecasts if f["restock_urgency"] in ("critical", "high")]
        total_cost = sum(
            f["optimal_reorder_qty"] * 0
            for f in urgent
        )
        plan = []
        for f in urgent:
            plan.append({
                "product_name": f["product_name"],
                "supplier_name": f["supplier_name"],
                "current_stock": f["current_stock"],
                "days_until_empty": f["days_until_empty"],
                "urgency": f["restock_urgency"],
                "recommended_order_qty": f["optimal_reorder_qty"],
                "action": "Order immediately" if f["restock_urgency"] == "critical" else "Order within 3 days"
            })
        return {
            "status": "success",
            "urgent_items": len(plan),
            "restock_plan": plan
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/health")
def health():
    return {"status": "healthy"}
