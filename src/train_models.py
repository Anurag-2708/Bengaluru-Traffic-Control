import os
import pickle
import json
import numpy as np
import pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
import lightgbm as lgb
import xgboost as xgb
import shap

from src.data_pipeline import load_and_clean_data, engineer_features, get_train_features

MODELS_DIR = "models"
METRICS_PATH = "data/model_metrics.json"
IMPORTANCE_PATH = "data/feature_importance.json"

def evaluate_multicollinearity(X):
    """
    Computes Pearson correlation matrix to monitor multicollinearity.
    """
    corr_matrix = X.corr().abs()
    # Find highly correlated features (> 0.8)
    upper_tri = corr_matrix.where(np.triu(np.ones(corr_matrix.shape), k=1).astype(bool))
    to_drop = [column for column in upper_tri.columns if any(upper_tri[column] > 0.8)]
    print("Feature Correlation Matrix:")
    print(corr_matrix.round(2))
    if to_drop:
        print(f"Highly correlated features detected (>0.8): {to_drop}")
    else:
        print("No high multicollinearity detected (>0.8 correlation).")
    return corr_matrix.to_dict()

def train_and_save_models(include_post_events=True):
    """
    Loads data, splits train/test, fits LightGBM and XGBoost models,
    computes SHAP importances, and saves models and metrics.
    """
    # Create models directory
    os.makedirs(MODELS_DIR, exist_ok=True)
    
    # Load and preprocess data
    df = load_and_clean_data(include_post_events=include_post_events)
    df = engineer_features(df)
    X, y_dur, y_sev = get_train_features(df)
    
    # Evaluate multicollinearity
    corr_dict = evaluate_multicollinearity(X)
    
    # Split datasets
    X_train, X_test, y_dur_train, y_dur_test = train_test_split(X, y_dur, test_size=0.2, random_state=42)
    _, _, y_sev_train, y_sev_test = train_test_split(X, y_sev, test_size=0.2, random_state=42)
    
    print("\n--- Training Models for Duration Prediction ---")
    # LightGBM Regressor
    lgb_dur = lgb.LGBMRegressor(n_estimators=100, random_state=42, verbose=-1)
    lgb_dur.fit(X_train, y_dur_train)
    
    # XGBoost Regressor
    xgb_dur = xgb.XGBRegressor(n_estimators=100, random_state=42, verbosity=0)
    xgb_dur.fit(X_train, y_dur_train)
    
    print("\n--- Training Models for Severity Prediction ---")
    lgb_sev = lgb.LGBMRegressor(n_estimators=100, random_state=42, verbose=-1)
    lgb_sev.fit(X_train, y_sev_train)
    
    xgb_sev = xgb.XGBRegressor(n_estimators=100, random_state=42, verbosity=0)
    xgb_sev.fit(X_train, y_sev_train)
    
    # Save models
    with open(f"{MODELS_DIR}/lgb_dur.pkl", "wb") as f:
        pickle.dump(lgb_dur, f)
    with open(f"{MODELS_DIR}/xgb_dur.pkl", "wb") as f:
        pickle.dump(xgb_dur, f)
    with open(f"{MODELS_DIR}/lgb_sev.pkl", "wb") as f:
        pickle.dump(lgb_sev, f)
    with open(f"{MODELS_DIR}/xgb_sev.pkl", "wb") as f:
        pickle.dump(xgb_sev, f)
        
    # Evaluate Predictions
    print("\n--- Evaluating Models on Test Set ---")
    # Duration evaluations
    pred_lgb_dur = lgb_dur.predict(X_test)
    pred_xgb_dur = xgb_dur.predict(X_test)
    pred_ens_dur = 0.5 * pred_lgb_dur + 0.5 * pred_xgb_dur  # Ensemble
    
    # Severity evaluations
    pred_lgb_sev = lgb_sev.predict(X_test)
    pred_xgb_sev = xgb_sev.predict(X_test)
    pred_ens_sev = 0.5 * pred_lgb_sev + 0.5 * pred_xgb_sev  # Ensemble
    
    metrics = {
        "duration": {
            "lgb": {
                "mae": mean_absolute_error(y_dur_test, pred_lgb_dur),
                "rmse": float(np.sqrt(mean_squared_error(y_dur_test, pred_lgb_dur))),
                "r2": r2_score(y_dur_test, pred_lgb_dur)
            },
            "xgb": {
                "mae": mean_absolute_error(y_dur_test, pred_xgb_dur),
                "rmse": float(np.sqrt(mean_squared_error(y_dur_test, pred_xgb_dur))),
                "r2": r2_score(y_dur_test, pred_xgb_dur)
            },
            "ensemble": {
                "mae": mean_absolute_error(y_dur_test, pred_ens_dur),
                "rmse": float(np.sqrt(mean_squared_error(y_dur_test, pred_ens_dur))),
                "r2": r2_score(y_dur_test, pred_ens_dur)
            }
        },
        "severity": {
            "lgb": {
                "mae": mean_absolute_error(y_sev_test, pred_lgb_sev),
                "rmse": float(np.sqrt(mean_squared_error(y_sev_test, pred_lgb_sev))),
                "r2": r2_score(y_sev_test, pred_lgb_sev)
            },
            "xgb": {
                "mae": mean_absolute_error(y_sev_test, pred_xgb_sev),
                "rmse": float(np.sqrt(mean_squared_error(y_sev_test, pred_xgb_sev))),
                "r2": r2_score(y_sev_test, pred_xgb_sev)
            },
            "ensemble": {
                "mae": mean_absolute_error(y_sev_test, pred_ens_sev),
                "rmse": float(np.sqrt(mean_squared_error(y_sev_test, pred_ens_sev))),
                "r2": r2_score(y_sev_test, pred_ens_sev)
            }
        },
        "correlations": corr_dict
    }
    
    with open(METRICS_PATH, "w") as f:
        json.dump(metrics, f, indent=4)
    print(f"Metrics saved to {METRICS_PATH}")
    
    # Compute SHAP Values (Global Explainability)
    print("\n--- Computing SHAP Values ---")
    importance = {}
    try:
        # Use LightGBM for SHAP calculations (it is fast and reliable with TreeExplainer)
        explainer_dur = shap.TreeExplainer(lgb_dur)
        shap_values_dur = explainer_dur.shap_values(X_test)
        
        # In newer shap versions, shap_values might be a list or array
        if isinstance(shap_values_dur, list):
            mean_shap_dur = np.abs(shap_values_dur[0]).mean(axis=0)
        else:
            mean_shap_dur = np.abs(shap_values_dur).mean(axis=0)
            
        explainer_sev = shap.TreeExplainer(lgb_sev)
        shap_values_sev = explainer_sev.shap_values(X_test)
        if isinstance(shap_values_sev, list):
            mean_shap_sev = np.abs(shap_values_sev[0]).mean(axis=0)
        else:
            mean_shap_sev = np.abs(shap_values_sev).mean(axis=0)
            
        # Store mean absolute SHAP feature importances
        importance = {
            "features": list(X.columns),
            "duration": list(mean_shap_dur),
            "severity": list(mean_shap_sev)
        }
    except Exception as e:
        print(f"SHAP computation warning: {e}. Falling back to default feature importances.")
        # Fallback to default Gini importance
        importance = {
            "features": list(X.columns),
            "duration": list(lgb_dur.feature_importances_.astype(float)),
            "severity": list(lgb_sev.feature_importances_.astype(float))
        }
        
    with open(IMPORTANCE_PATH, "w") as f:
        json.dump(importance, f, indent=4)
    print(f"Feature importances saved to {IMPORTANCE_PATH}")
    
    print("\n--- Training Pipeline Complete ---")
    print(f"Duration Ensemble MAE: {metrics['duration']['ensemble']['mae']:.2f} mins")
    print(f"Severity Ensemble MAE: {metrics['severity']['ensemble']['mae']:.2f}")
    
    return metrics

if __name__ == "__main__":
    train_and_save_models(include_post_events=False)
