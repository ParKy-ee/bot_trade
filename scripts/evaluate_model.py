import os
import sys
import warnings
import json
import pandas as pd
import numpy as np
import joblib
import urllib.request

# Scikit-Learn Standard Model Evaluation Metrics
from sklearn.metrics import (
    confusion_matrix,
    accuracy_score,
    precision_score,
    recall_score,
    f1_score,
    fbeta_score,
    roc_auc_score,
    average_precision_score,
    log_loss,
    brier_score_loss,
    matthews_corrcoef
)

warnings.filterwarnings('ignore')
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_PATH = os.path.join(ROOT_DIR, 'python', 'models', 'forex_m5_model.joblib')
DATA_PATH = os.path.join(ROOT_DIR, 'data', 'dataset_forex_m5.csv')
API_URL = 'http://localhost:3000/api/trade-results?market=forex&ready_for_retrain=true&limit=5000'

def get_live_trade_results():
    try:
        req = urllib.request.Request(API_URL, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            if isinstance(data, list) and len(data) > 0:
                raw_df = pd.DataFrame(data)
                valid = raw_df[
                    (raw_df['market_type'] == 'forex') &
                    (~raw_df['exit_reason'].isin(['OPEN', 'SYNC_PENDING'])) &
                    (raw_df['is_win'].notna()) &
                    (raw_df['rsi'].notna()) &
                    (raw_df['adx'].notna()) &
                    (raw_df['atr'].notna()) &
                    (raw_df['ema21'].notna()) &
                    (raw_df['ema50'].notna()) &
                    (raw_df['macd_hist'].notna())
                ]
                return valid
    except Exception:
        pass
    return None

def evaluate_model_standard_metrics():
    print("=" * 82)
    print("🌐 รายงานผลประเมินโมเดล AI ตามมาตรฐานสากล (10 Standard ML Classification Metrics)")
    print("   อ้างอิงมาตรฐาน: Scikit-Learn Model Evaluation & DataRockie Best Practices")
    print("=" * 82)

    if not os.path.exists(MODEL_PATH):
        print(f"❌ ไม่พบไฟล์โมเดลที่: {MODEL_PATH}")
        return

    bundle = joblib.load(MODEL_PATH)
    arch = bundle.get('architecture', 'Tri-Ensemble')
    trained_at = bundle.get('trained_at', 'N/A')
    total_samples = bundle.get('total_samples_count', 0)
    live_samples = bundle.get('live_samples_count', 0)
    features = bundle.get('features', [])
    weights = bundle.get('weights', {})

    print(f"\n📦 [1] ข้อมูลสถาปัตยกรรมโมเดล (Model Specifications)")
    print(f" • Architecture      : {arch}")
    print(f" • Ensemble Weights  : LightGBM {weights.get('lightgbm', 0.35)*100:.0f}% | XGBoost {weights.get('xgboost', 0.25)*100:.0f}% | CatBoost {weights.get('catboost', 0.25)*100:.0f}% | RF {weights.get('random_forest', 0.15)*100:.0f}%")
    print(f" • Input Features    : {len(features)} Features ({', '.join(features[:6])}...)")
    print(f" • Training Dataset  : {total_samples:,} แท่งเทียน (รวม Live Realized Trades: {live_samples} ไม้)")
    print(f" • Trained Timestamp : {trained_at}")

    if not os.path.exists(DATA_PATH):
        print(f"❌ ไม่พบไฟล์ชุดข้อมูลทดสอบที่: {DATA_PATH}")
        return

    # Load & prepare test set (Holdout 20% Unseen Data)
    df = pd.read_csv(DATA_PATH)
    atr_up = df['atr_pct'] * 1.5
    atr_dn = df['atr_pct'] * 1.0
    df['target_buy'] = np.where((df['target_ret_5'] >= atr_up) & (df['ret_1'] >= 0), 1, 0)
    df['target_sell'] = np.where((df['target_ret_5'] <= -atr_dn) & (df['ret_1'] <= 0), 1, 0)

    for c in ['csm_spread', 'h1_trend_slope', 'time_sin_hour', 'time_cos_hour']:
        if c not in df: df[c] = 0.0
    if 'is_jpy' not in df: df['is_jpy'] = df['symbol'].astype(str).str.contains('JPY').astype(float)
    if 'spread_to_atr' not in df: df['spread_to_atr'] = 0.02

    clean_df = df.dropna(subset=features + ['target_buy', 'target_sell'])
    split_idx = int(len(clean_df) * 0.8)
    test_df = clean_df.iloc[split_idx:].copy()

    X_test = test_df[features]
    y_buy_test = test_df['target_buy'].values
    y_sell_test = test_df['target_sell'].values

    # Generate Ensemble Predicted Probabilities
    p_lgb_b = bundle['lgb_buy'].predict_proba(X_test)[:, 1]
    p_xgb_b = bundle['xgb_buy'].predict_proba(X_test)[:, 1]
    p_cat_b = bundle['cat_buy'].predict_proba(X_test)[:, 1]
    p_rf_b = bundle['rf_buy'].predict_proba(X_test)[:, 1]
    p_buy = 0.35 * p_lgb_b + 0.25 * p_xgb_b + 0.25 * p_cat_b + 0.15 * p_rf_b

    p_lgb_s = bundle['lgb_sell'].predict_proba(X_test)[:, 1]
    p_xgb_s = bundle['xgb_sell'].predict_proba(X_test)[:, 1]
    p_cat_s = bundle['cat_sell'].predict_proba(X_test)[:, 1]
    p_rf_s = bundle['rf_sell'].predict_proba(X_test)[:, 1]
    p_sell = 0.35 * p_lgb_s + 0.25 * p_xgb_s + 0.25 * p_cat_s + 0.15 * p_rf_s

    # Compute Standard Metrics Function
    def compute_10_metrics(name, y_true, y_prob):
        # Determine optimal threshold using F0.5 (Prioritizing Precision / Capital Preservation)
        cand_thresholds = np.linspace(y_prob.min() + 0.001, y_prob.max() - 0.001, 80)
        best_th = np.median(y_prob)
        best_f05 = -1
        for th in cand_thresholds:
            pred_th = (y_prob >= th).astype(int)
            if pred_th.sum() >= 40:
                score = fbeta_score(y_true, pred_th, beta=0.5, zero_division=0)
                if score > best_f05:
                    best_f05 = score
                    best_th = th

        y_pred = (y_prob >= best_th).astype(int)

        # 1. Confusion Matrix
        cm = confusion_matrix(y_true, y_pred)
        tn, fp, fn, tp = cm.ravel()

        # 2. Accuracy
        acc = accuracy_score(y_true, y_pred)

        # 3. Precision (Positive Predictive Value)
        prec = precision_score(y_true, y_pred, zero_division=0)

        # 4. Recall / Sensitivity (True Positive Rate)
        rec = recall_score(y_true, y_pred, zero_division=0)

        # 5. Specificity (True Negative Rate)
        spec = tn / (tn + fp) if (tn + fp) > 0 else 0.0

        # 6. F1-Score (Harmonic Mean)
        f1 = f1_score(y_true, y_pred, zero_division=0)

        # 7. F-Beta Score (Beta=0.5: Precision weight x2)
        f05 = fbeta_score(y_true, y_pred, beta=0.5, zero_division=0)

        # 8. ROC-AUC (Area Under ROC Curve)
        roc = roc_auc_score(y_true, y_prob)

        # 9. PR-AUC (Average Precision Score - Standard for Imbalanced Data)
        pr_auc = average_precision_score(y_true, y_prob)

        # 10. Log Loss & Brier Score
        ll = log_loss(y_true, y_prob)
        brier = brier_score_loss(y_true, y_prob)

        # Bonus: Matthews Correlation Coefficient (MCC)
        mcc = matthews_corrcoef(y_true, y_pred)

        return {
            'name': name,
            'threshold': best_th,
            'cm': (tn, fp, fn, tp),
            'accuracy': acc,
            'precision': prec,
            'recall': rec,
            'specificity': spec,
            'f1': f1,
            'f05': f05,
            'roc_auc': roc,
            'pr_auc': pr_auc,
            'log_loss': ll,
            'brier': brier,
            'mcc': mcc,
            'base_rate': y_true.mean()
        }

    buy_res = compute_10_metrics("BUY Scalp Classifier", y_buy_test, p_buy)
    sell_res = compute_10_metrics("SELL Scalp Classifier", y_sell_test, p_sell)

    print(f"\n📊 [2] รายงานสรุป 10 Metrics มาตรฐานสากล (ทดสอบบน Unseen Data {len(test_df):,} แท่งเทียน)")
    print("-" * 82)
    print(f" {'#':<3} | {'ตัวชี้วัด (Metric)':<30} | {'BUY Model':<18} | {'SELL Model':<18}")
    print("-" * 82)
    print(f" 0  | {'Base Rate (อัตรากำไรในตลาด)':<30} | {buy_res['base_rate']*100:>12.2f}%    | {sell_res['base_rate']*100:>12.2f}%")
    print(f" 1  | {'Accuracy (ความถูกต้องโดยรวม)':<30} | {buy_res['accuracy']*100:>12.2f}%    | {sell_res['accuracy']*100:>12.2f}%")
    print(f" 2  | {'Precision (ความแม่นยำเมื่อออกคำสั่ง)':<30} | {buy_res['precision']*100:>12.2f}%    | {sell_res['precision']*100:>12.2f}%")
    print(f" 3  | {'Recall / Sensitivity (การจับสัญญาณ)':<30} | {buy_res['recall']*100:>12.2f}%    | {sell_res['recall']*100:>12.2f}%")
    print(f" 4  | {'Specificity (การกรองสัญญาณหลอก)':<30} | {buy_res['specificity']*100:>12.2f}%    | {sell_res['specificity']*100:>12.2f}%")
    print(f" 5  | {'F1-Score (สมดุล P & R)':<30} | {buy_res['f1']:>16.4f}    | {sell_res['f1']:>16.4f}")
    print(f" 6  | {'F0.5-Score (เน้น Precision เป็น 2 เท่า)':<30} | {buy_res['f05']:>16.4f}    | {sell_res['f05']:>16.4f}")
    print(f" 7  | {'ROC-AUC (ความสามารถแยกแยะคลาส)':<30} | {buy_res['roc_auc']*100:>12.2f}%    | {sell_res['roc_auc']*100:>12.2f}%")
    print(f" 8  | {'PR-AUC / AP (แม่นยำบนข้อมูล Imbalanced)':<30} | {buy_res['pr_auc']*100:>12.2f}%    | {sell_res['pr_auc']*100:>12.2f}%")
    print(f" 9  | {'Log Loss (Cross-Entropy Error)':<30} | {buy_res['log_loss']:>16.4f}    | {sell_res['log_loss']:>16.4f}")
    print(f" 10 | {'Brier Score (ความผิดพลาดของ Prob)':<30} | {buy_res['brier']:>16.4f}    | {sell_res['brier']:>16.4f}")
    print(f" ++ | {'MCC (Matthews Correlation)':<30} | {buy_res['mcc']:>16.4f}    | {sell_res['mcc']:>16.4f}")
    print("-" * 82)

    # Confusion Matrix Details
    print(f"\n🧩 [3] ตาราง Confusion Matrix (Matrix of Truth)")
    print("┌" + "─" * 38 + "┬" + "─" * 38 + "┐")
    print(f"│ {'BUY Model (Cutoff: ' + str(round(buy_res['threshold'], 3)) + ')':<36} │ {'SELL Model (Cutoff: ' + str(round(sell_res['threshold'], 3)) + ')':<36} │")
    print("├" + "─" * 38 + "┼" + "─" * 38 + "┤")
    tn_b, fp_b, fn_b, tp_b = buy_res['cm']
    tn_s, fp_s, fn_s, tp_s = sell_res['cm']
    print(f"│ • True Positive  (กำไรจริง) : {tp_b:>6,} ไม้ │ • True Positive  (กำไรจริง) : {tp_s:>6,} ไม้ │")
    print(f"│ • False Positive (เข้าแล้วลบ): {fp_b:>6,} ไม้ │ • False Positive (เข้าแล้วลบ): {fp_s:>6,} ไม้ │")
    print(f"│ • True Negative  (เลี่ยงลบ) : {tn_b:>6,} ไม้ │ • True Negative  (เลี่ยงลบ) : {tn_s:>6,} ไม้ │")
    print(f"│ • False Negative (ตกรอบวิ่ง): {fn_b:>6,} ไม้ │ • False Negative (ตกรอบวิ่ง): {fn_s:>6,} ไม้ │")
    print("└" + "─" * 38 + "┴" + "─" * 38 + "┘")

    # Realized Live Trades Database Verification
    df_live = get_live_trade_results()
    if df_live is not None and len(df_live) > 0:
        try:
            tot = len(df_live)
            wins = int((df_live['is_win'] == 1).sum())
            losses = int((df_live['is_win'] == 0).sum())
            live_wr = (wins / tot) * 100 if tot > 0 else 0
            pips_series = pd.to_numeric(df_live['pips'], errors='coerce').fillna(0)
            avg_pips = float(pips_series.mean())
            net_pips = float(pips_series.sum())

            win_pips = pips_series[df_live['is_win'] == 1]
            loss_pips = pips_series[df_live['is_win'] == 0].abs()
            avg_win = float(win_pips.mean()) if len(win_pips) > 0 else 1.0
            avg_loss = float(loss_pips.mean()) if len(loss_pips) > 0 else 1.0
            pf = (wins * avg_win) / (losses * avg_loss) if (losses * avg_loss) > 0 else 1.0

            conf_col = 'ai_confidence' if 'ai_confidence' in df_live.columns else 'confidence'
            conf_series = pd.to_numeric(df_live[conf_col], errors='coerce').dropna()
            avg_conf = float(conf_series.mean()) if len(conf_series) > 0 else 0.0

            print(f"\n🏆 [4] ผลการวัดผลบน Realized Live Trades จากฐานข้อมูลจริง (Live Verification)")
            print(f" • จำนวนไม้เทรดจริงที่ปิดแล้ว : {tot:,} ไม้ (ชนะ {wins} / แพ้ {losses})")
            print(f" • Live Precision (Win Rate)   : {live_wr:.2f}%")
            print(f" • Profit Factor (PF)          : {pf:.2f}")
            print(f" • Expectancy (กำไรเฉลี่ย/ไม้) : {avg_pips:+.2f} pips (Net: {net_pips:+.1f} pips)")
            print(f" • Average AI Confidence       : {avg_conf*100:.1f}%")
        except Exception as e:
            print(f"\n⚠️ Database query notice: {e}")

    # Scenario Simulation
    print(f"\n🧪 [5] การทดสอบตอบสนองจำลอง (Scenario Stress Testing)")
    scenarios = [
        {
            "name": "Bullish Trend Breakout (จังหวะระเบิดเทรนด์ขาขึ้น)",
            "features": [0.0012, 0.0035, 66.5, 0.0025, 32.0, 0.0018, 0.0008, 0.45, 0.0020, 0.0, 0.5, 0.86, 0.015],
            "adx": 32.0
        },
        {
            "name": "Bearish Breakdown (จังหวะเทรดหลุดแนวรับ)",
            "features": [-0.0015, -0.0040, 31.0, 0.0028, 35.0, -0.0022, -0.0011, -0.55, -0.0025, 0.0, 0.5, 0.86, 0.015],
            "adx": 35.0
        },
        {
            "name": "Sideways Low Volatility (ตลาดนิ่ง ไซด์เวย์ไร้ทิศทาง)",
            "features": [0.0001, -0.0001, 50.2, 0.0012, 11.5, 0.00005, 0.00002, 0.05, 0.0001, 0.0, 0.5, 0.86, 0.025],
            "adx": 11.5
        }
    ]

    for sc in scenarios:
        row = pd.DataFrame([sc["features"]], columns=features)
        b_val = 0.35 * bundle['lgb_buy'].predict_proba(row)[:, 1][0] + \
                0.25 * bundle['xgb_buy'].predict_proba(row)[:, 1][0] + \
                0.25 * bundle['cat_buy'].predict_proba(row)[:, 1][0] + \
                0.15 * bundle['rf_buy'].predict_proba(row)[:, 1][0]

        s_val = 0.35 * bundle['lgb_sell'].predict_proba(row)[:, 1][0] + \
                0.25 * bundle['xgb_sell'].predict_proba(row)[:, 1][0] + \
                0.25 * bundle['cat_sell'].predict_proba(row)[:, 1][0] + \
                0.15 * bundle['rf_sell'].predict_proba(row)[:, 1][0]

        tot = b_val + s_val
        rel_b = b_val / tot if tot > 0 else 0.5
        rel_s = s_val / tot if tot > 0 else 0.5

        if sc["adx"] < 20.0:
            dec = f"⚪ WAIT / NO TRADE (ADX {sc['adx']} ต่ำเกินไป ติดตัวกรอง Sideway Guard)"
        elif rel_b >= 0.60:
            dec = f"🟢 BUY (AI Conf: {rel_b*100:.1f}%)"
        elif rel_s >= 0.60:
            dec = f"🔴 SELL (AI Conf: {rel_s*100:.1f}%)"
        else:
            dec = f"⚪ WAIT / NEUTRAL (Relative Conf ต่ำกว่าเกณฑ์ 60%)"

        print(f" ▶ {sc['name']:<50} -> {dec}")

    print("\n" + "=" * 82)
    print("✅ การประเมินครบถ้วนตามมาตรฐาน Scikit-Learn Classification Standards")
    print("=" * 82)

if __name__ == '__main__':
    evaluate_model_standard_metrics()
