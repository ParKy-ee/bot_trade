import os
import sys
import json
import shutil
import warnings

warnings.filterwarnings('ignore')
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS_DIR = os.path.join(ROOT_DIR, 'python', 'models')

IS_CRYPTO = '--crypto' in sys.argv
REGISTRY_PATH = os.path.join(MODELS_DIR, 'crypto_model_registry.json' if IS_CRYPTO else 'model_registry.json')
ACTIVE_MODEL_PATH = os.path.join(MODELS_DIR, 'crypto_m5_model.joblib' if IS_CRYPTO else 'forex_m5_model.joblib')
MARKET_TITLE = "Crypto (Binance BTC/ETH/SOL)" if IS_CRYPTO else "Forex M5"

def load_registry():
    if not os.path.exists(REGISTRY_PATH):
        print(f"❌ ไม่พบไฟล์ Model Registry ที่: {REGISTRY_PATH}")
        sys.exit(1)
    with open(REGISTRY_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)

def save_registry(data):
    with open(REGISTRY_PATH, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

def list_versions():
    reg = load_registry()
    active = reg.get('active_version', 'N/A')
    versions = reg.get('versions', [])

    print("=" * 95)
    print(f"🏷️  AI MODEL REGISTRY [{MARKET_TITLE}] - บัญชีควบคุมเวอร์ชันโมเดล")
    print(f"   โมเดลที่กำลังใช้งานในระบบเทรดปัจจุบัน: [{active}]")
    print("=" * 95)
    print(f" {'Ver':<8} | {'Status':<10} | {'Trained Date':<19} | {'Samples (Hist + Live)':<21} | {'ROC-AUC (B/S)':<15} | {'Architecture':<22}")
    print("-" * 95)

    for v in versions:
        ver_tag = v['version']
        status = "🟢 ACTIVE" if ver_tag == active else "⚪ ARCHIVED"
        trained = v.get('created_at', 'N/A')[:19].replace('T', ' ')
        tot = f"{v.get('dataset', {}).get('total_samples', 0):,}"
        live_n = v.get('dataset', {}).get('live_trade_samples', 0)
        samples_str = f"{tot} (+{live_n} live)" if live_n > 0 else f"{tot} (0 live)"
        m = v.get('metrics', {})
        auc_b = m.get('roc_auc_buy', 0) * 100
        auc_s = m.get('roc_auc_sell', 0) * 100
        auc_str = f"{auc_b:.1f}% / {auc_s:.1f}%"
        arch = v.get('architecture', 'N/A')
        if len(arch) > 22:
            arch = arch[:19] + "..."
        print(f" {ver_tag:<8} | {status:<10} | {trained:<19} | {samples_str:<21} | {auc_str:<15} | {arch:<22}")

    print("-" * 95)
    print("💡 คำสั่งใช้งาน:")
    print(" • ดูรายละเอียดฉบับเต็ม   : python scripts/model_registry.py --show <version>")
    print(" • เปรียบเทียบ 2 เวอร์ชั่น: python scripts/model_registry.py --compare <v1> <v2>")
    print(" • สลับเวอร์ชันใช้งาน     : python scripts/model_registry.py --activate <version>")
    print("=" * 88)

def show_version(ver_target):
    reg = load_registry()
    active = reg.get('active_version', 'N/A')
    target = None
    for v in reg.get('versions', []):
        if v['version'].lower() == ver_target.lower():
            target = v
            break

    if not target:
        print(f"❌ ไม่พบข้อมูลเวอร์ชัน: {ver_target}")
        return

    print("=" * 80)
    print(f"📋 รายละเอียดสเปกและพารามิเตอร์โมเดล: {target['version']} {'(🟢 กำลังใช้งาน)' if target['version'] == active else ''}")
    print("=" * 80)
    print(f" • คำอธิบาย (Description) : {target.get('description', '-')}")
    print(f" • วันที่ฝึกสอน (Created)   : {target.get('created_at', '-')}")
    print(f" • ไฟล์โมเดล (File Path)  : {target.get('file', '-')}")
    print(f" • สถาปัตยกรรมโมเดล      : {target.get('architecture', '-')}")

    print(f"\n📊 [1] ข้อมูลชุดข้อมูลฝึกสอน (Dataset Breakdown)")
    ds = target.get('dataset', {})
    print(f" • จำนวนข้อมูลทั้งหมด (Total)   : {ds.get('total_samples', 0):,} แท่ง")
    print(f" • ข้อมูลประวัติศาสตร์ (Historical): {ds.get('historical_samples', 0):,} แท่ง")
    print(f" • ไม้เทรดจริงจาก DB (Live Trades): {ds.get('live_trade_samples', 0):,} ไม้")
    print(f" • แบ่ง Train / Test Set          : {ds.get('train_samples', 0):,} / {ds.get('test_samples', 0):,} แท่ง")
    print(f" • สัดส่วนสัญญาณกำไร Base Rate    : BUY {ds.get('positive_rate_buy', 0)*100:.2f}% | SELL {ds.get('positive_rate_sell', 0)*100:.2f}%")

    print(f"\n⚙️ [2] พารามิเตอร์ของโมเดล (Constituent Hyperparameters)")
    params = target.get('parameters', {})
    for model_name, p_dict in params.items():
        print(f" ▶ [{model_name.upper()}]:")
        for k, val in p_dict.items():
            print(f"    - {k:<16}: {val}")

    print(f"\n🎯 [3] ตัวแปรฟีเจอร์ที่ใช้ (Features - {len(target.get('features', []))} ตัวแปร)")
    print(f"   {', '.join(target.get('features', []))}")

    print(f"\n📈 [4] ผลการวัดผล 10 Standard Metrics (Unseen Test Data)")
    m = target.get('metrics', {})
    print(f" {'ตัวชี้วัด (Metric)':<26} | {'BUY Model':<14} | {'SELL Model':<14}")
    print("-" * 60)
    print(f" {'Accuracy':<26} | {m.get('accuracy_buy', 0)*100:>11.2f}% | {m.get('accuracy_sell', 0)*100:>11.2f}%")
    print(f" {'Precision (Win Rate)':<26} | {m.get('precision_buy', 0)*100:>11.2f}% | {m.get('precision_sell', 0)*100:>11.2f}%")
    print(f" {'Recall (Sensitivity)':<26} | {m.get('recall_buy', 0)*100:>11.2f}% | {m.get('recall_sell', 0)*100:>11.2f}%")
    print(f" {'Specificity':<26} | {m.get('specificity_buy', 0)*100:>11.2f}% | {m.get('specificity_sell', 0)*100:>11.2f}%")
    print(f" {'F1-Score':<26} | {m.get('f1_buy', 0):>12.4f} | {m.get('f1_sell', 0):>12.4f}")
    print(f" {'F0.5-Score (เน้น P x2)':<26} | {m.get('f05_buy', 0):>12.4f} | {m.get('f05_sell', 0):>12.4f}")
    print(f" {'ROC-AUC':<26} | {m.get('roc_auc_buy', 0)*100:>11.2f}% | {m.get('roc_auc_sell', 0)*100:>11.2f}%")
    print(f" {'PR-AUC / AP':<26} | {m.get('pr_auc_buy', 0)*100:>11.2f}% | {m.get('pr_auc_sell', 0)*100:>11.2f}%")
    print(f" {'Log Loss':<26} | {m.get('log_loss_buy', 0):>12.4f} | {m.get('log_loss_sell', 0):>12.4f}")
    print(f" {'Brier Score':<26} | {m.get('brier_buy', 0):>12.4f} | {m.get('brier_sell', 0):>12.4f}")
    print(f" {'MCC Correlation':<26} | {m.get('mcc_buy', 0):>12.4f} | {m.get('mcc_sell', 0):>12.4f}")
    print("=" * 80)

def compare_versions(v1_name, v2_name):
    reg = load_registry()
    v_map = {v['version'].lower(): v for v in reg.get('versions', [])}
    if v1_name.lower() not in v_map or v2_name.lower() not in v_map:
        print(f"❌ ระบุเวอร์ชันไม่ถูกต้อง: ตรวจสอบเวอร์ชันผ่านคำสั่ง --list")
        return

    v1 = v_map[v1_name.lower()]
    v2 = v_map[v2_name.lower()]

    print("=" * 85)
    print(f"⚖️  เปรียบเทียบโมเดล: [{v1['version']}] VS [{v2['version']}]")
    print("=" * 85)
    print(f" {'หัวข้อเปรียบเทียบ':<26} | {v1['version']:<25} | {v2['version']:<25}")
    print("-" * 85)
    print(f" {'Architecture':<26} | {v1.get('architecture', '-')[:24]:<25} | {v2.get('architecture', '-')[:24]:<25}")
    print(f" {'Features Count':<26} | {len(v1.get('features', [])):<25} | {len(v2.get('features', [])):<25}")
    print(f" {'Live Trades Used':<26} | {v1.get('dataset', {}).get('live_trade_samples', 0):<25} | {v2.get('dataset', {}).get('live_trade_samples', 0):<25}")
    tot1 = f"{v1.get('dataset', {}).get('total_samples', 0):,}"
    tot2 = f"{v2.get('dataset', {}).get('total_samples', 0):,}"
    print(f" {'Total Samples':<26} | {tot1:<25} | {tot2:<25}")

    m1 = v1.get('metrics', {})
    m2 = v2.get('metrics', {})

    print("-" * 85)
    print(" 📈 เปรียบเทียบ Metrics ฝั่ง BUY:")
    diff_auc_b = (m2.get('roc_auc_buy', 0) - m1.get('roc_auc_buy', 0)) * 100
    print(f" • ROC-AUC BUY              | {m1.get('roc_auc_buy', 0)*100:>6.2f}%                    | {m2.get('roc_auc_buy', 0)*100:>6.2f}% ({diff_auc_b:+.2f}%)")
    diff_prec_b = (m2.get('precision_buy', 0) - m1.get('precision_buy', 0)) * 100
    print(f" • Precision BUY            | {m1.get('precision_buy', 0)*100:>6.2f}%                    | {m2.get('precision_buy', 0)*100:>6.2f}% ({diff_prec_b:+.2f}%)")
    diff_f05_b = m2.get('f05_buy', 0) - m1.get('f05_buy', 0)
    print(f" • F0.5-Score BUY           | {m1.get('f05_buy', 0):>6.4f}                     | {m2.get('f05_buy', 0):>6.4f} ({diff_f05_b:+.4f})")

    print("-" * 85)
    print(" 📉 เปรียบเทียบ Metrics ฝั่ง SELL:")
    diff_auc_s = (m2.get('roc_auc_sell', 0) - m1.get('roc_auc_sell', 0)) * 100
    print(f" • ROC-AUC SELL             | {m1.get('roc_auc_sell', 0)*100:>6.2f}%                    | {m2.get('roc_auc_sell', 0)*100:>6.2f}% ({diff_auc_s:+.2f}%)")
    diff_prec_s = (m2.get('precision_sell', 0) - m1.get('precision_sell', 0)) * 100
    print(f" • Precision SELL           | {m1.get('precision_sell', 0)*100:>6.2f}%                    | {m2.get('precision_sell', 0)*100:>6.2f}% ({diff_prec_s:+.2f}%)")
    diff_f05_s = m2.get('f05_sell', 0) - m1.get('f05_sell', 0)
    print(f" • F0.5-Score SELL          | {m1.get('f05_sell', 0):>6.4f}                     | {m2.get('f05_sell', 0):>6.4f} ({diff_f05_s:+.4f})")

    print("=" * 85)

def activate_version(ver_target):
    reg = load_registry()
    target = None
    for v in reg.get('versions', []):
        if v['version'].lower() == ver_target.lower():
            target = v
            break

    if not target:
        print(f"❌ ไม่พบเวอร์ชัน: {ver_target}")
        return

    ver_file = os.path.join(MODELS_DIR, target['file'])
    if not os.path.exists(ver_file):
        print(f"❌ ไม่พบไฟล์โมเดลที่: {ver_file}")
        return

    shutil.copy2(ver_file, ACTIVE_MODEL_PATH)
    reg['active_version'] = target['version']
    save_registry(reg)

    print(f"✅ สลับเวอร์ชันโมเดลสำเร็จ! ตอนนี้ระบบกำลังใช้งาน: [{target['version']}] ({target['description']})")

if __name__ == '__main__':
    args = sys.argv[1:]
    if not args or '--list' in args:
        list_versions()
    elif '--show' in args:
        idx = args.index('--show')
        if idx + 1 < len(args):
            show_version(args[idx + 1])
        else:
            print("กรุณาระบุเวอร์ชัน เช่น: python scripts/model_registry.py --show v1.1.0")
    elif '--compare' in args:
        idx = args.index('--compare')
        if idx + 2 < len(args):
            compare_versions(args[idx + 1], args[idx + 2])
        else:
            compare_versions('v1.0.0', 'v1.1.0')
    elif '--activate' in args:
        idx = args.index('--activate')
        if idx + 1 < len(args):
            activate_version(args[idx + 1])
        else:
            print("กรุณาระบุเวอร์ชัน เช่น: python scripts/model_registry.py --activate v1.0.0")
    else:
        list_versions()
