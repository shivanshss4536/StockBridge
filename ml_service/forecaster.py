import sqlite3
import numpy as np
import pandas as pd
from sklearn.linear_model import LinearRegression
import os

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'database.sqlite')


def get_products():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("""
        SELECT p.id, p.name, p.sku, p.current_stock, p.minimum_stock,
               p.unit_cost, p.standard_reorder_qty, s.name as supplier_name
        FROM products p
        LEFT JOIN suppliers s ON p.supplier_id = s.id
    """)
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows


def simulate_sales_history(current_stock, minimum_stock, days=30):
    """
    Simulate past 30 days of sales data for a product.
    In a real system this would come from an actual sales_log table.
    We derive a realistic burn rate from the stock levels.
    """
    np.random.seed(42)
    base_daily_sales = max(1, (minimum_stock * 3) * 0.05)
    noise = np.random.normal(0, base_daily_sales * 0.2, days)
    daily_sales = np.maximum(0, base_daily_sales + noise)

    stock_levels = []
    stock = current_stock + sum(daily_sales)
    for sale in daily_sales:
        stock_levels.append(round(stock))
        stock -= sale

    return daily_sales, stock_levels


def forecast_product(product):
    current_stock = product['current_stock'] or 0
    minimum_stock = product['minimum_stock'] or 0

    daily_sales, stock_history = simulate_sales_history(current_stock, minimum_stock)

    days = np.arange(len(daily_sales)).reshape(-1, 1)
    model = LinearRegression()
    model.fit(days, daily_sales)

    avg_daily_burn = max(0.1, float(np.mean(daily_sales)))
    burn_trend = float(model.coef_[0])

    if avg_daily_burn > 0:
        days_until_min = max(0, round((current_stock - minimum_stock) / avg_daily_burn))
        days_until_empty = max(0, round(current_stock / avg_daily_burn))
    else:
        days_until_min = 999
        days_until_empty = 999

    restock_urgency = "critical" if days_until_min <= 3 else \
                      "high" if days_until_min <= 7 else \
                      "medium" if days_until_min <= 14 else "low"

    optimal_reorder_qty = round(avg_daily_burn * 30)

    return {
        "product_id": product['id'],
        "product_name": product['name'],
        "supplier_name": product['supplier_name'],
        "current_stock": current_stock,
        "minimum_stock": minimum_stock,
        "avg_daily_burn": round(avg_daily_burn, 2),
        "burn_trend": round(burn_trend, 3),
        "days_until_min_stock": days_until_min,
        "days_until_empty": days_until_empty,
        "restock_urgency": restock_urgency,
        "optimal_reorder_qty": optimal_reorder_qty,
        "predicted_value_at_risk": round(days_until_min * avg_daily_burn * (product['unit_cost'] or 0), 2)
    }


def run_forecast():
    products = get_products()
    results = [forecast_product(p) for p in products]
    results.sort(key=lambda x: x['days_until_min_stock'])
    return results
