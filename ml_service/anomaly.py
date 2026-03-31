import numpy as np
from sklearn.ensemble import IsolationForest
from forecaster import get_products, simulate_sales_history


def run_anomaly_detection():
    products = get_products()

    if len(products) < 2:
        return [{
            "product_id": p['id'],
            "product_name": p['name'],
            "current_stock": p['current_stock'] or 0,
            "anomaly_score": 0.0,
            "is_anomaly": False,
            "reason": "Not enough products for anomaly detection (need at least 2)"
        } for p in products]

    feature_matrix = []
    for p in products:
        cs = p['current_stock'] or 0
        ms = p['minimum_stock'] or 0
        uc = p['unit_cost'] or 0
        ratio = cs / ms if ms > 0 else 10.0
        feature_matrix.append([cs, ms, ratio, uc])

    X = np.array(feature_matrix, dtype=float)

    model = IsolationForest(contamination=0.2, random_state=42)
    model.fit(X)

    scores = model.decision_function(X)
    labels = model.predict(X)

    results = []
    for i, p in enumerate(products):
        cs = p['current_stock'] or 0
        ms = p['minimum_stock'] or 0
        is_anomaly = bool(labels[i] == -1)

        if is_anomaly:
            if cs == 0:
                reason = "Stock completely depleted — unusual pattern detected"
            elif cs < ms * 0.3:
                reason = "Stock critically below minimum threshold"
            elif cs > ms * 10:
                reason = "Unusually high stock level — possible data entry error"
            else:
                reason = "Irregular stock pattern vs rest of inventory"
        else:
            reason = "Normal stock pattern"

        results.append({
            "product_id": p['id'],
            "product_name": p['name'],
            "supplier_name": p['supplier_name'],
            "current_stock": cs,
            "minimum_stock": ms,
            "anomaly_score": round(float(scores[i]), 4),
            "is_anomaly": is_anomaly,
            "reason": reason
        })

    results.sort(key=lambda x: x['anomaly_score'])
    return results
