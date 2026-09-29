import joblib, pymysql, os, json
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, balanced_accuracy_score

from retrain_and_compare_pressure import (
    load_and_prepare_bars, evaluate_model, FEATURE_COLS, 
    run_live_observations_benchmark, CHAMPION_PATH, CHALLENGER_PATH
)

def run():
    df_train, df_test = load_and_prepare_bars()
    X_train, y_train = df_train[FEATURE_COLS].values, df_train['target'].values
    X_test, y_test = df_test[FEATURE_COLS].values, df_test['target'].values
    fwd_test = df_test['fwd_3_atr'].values

    champion = joblib.load(CHAMPION_PATH)
    champ_oos = evaluate_model(champion, X_test, y_test, fwd_test)
    obs_res = run_live_observations_benchmark(champion, champion)
    champ_obs, _, _ = obs_res

    print("\n👑 CHAMPION BASELINE:")
    print(f"  • OOS Holdout: BalAcc={champ_oos['balanced_accuracy']*100:.2f}%, DirWin={champ_oos['dir_win_rate']*100:.2f}%, ChopPrec={champ_oos['chop_precision']*100:.2f}%, Edge={champ_oos['avg_dir_edge']:.3f} ATR")
    print(f"  • LIVE Obs:    Acc={champ_obs['accuracy']*100:.2f}%, DirWin={champ_obs['dir_win_rate']*100:.2f}%, Edge={champ_obs['avg_dir_edge']:.3f} ATR, HighSafe={champ_obs['high_safe_avg']*100:.2f}%")

    configs = [
        ('Challenger_D7_N150', RandomForestClassifier(n_estimators=150, max_depth=7, class_weight='balanced', random_state=42, n_jobs=-1)),
        ('Challenger_D7_Leaf20', RandomForestClassifier(n_estimators=150, max_depth=7, min_samples_leaf=20, class_weight='balanced', random_state=42, n_jobs=-1)),
        ('Challenger_D8_Leaf25', RandomForestClassifier(n_estimators=150, max_depth=8, min_samples_leaf=25, class_weight='balanced', random_state=42, n_jobs=-1)),
    ]

    best_name = None
    best_clf = None
    best_score = -1

    for name, clf in configs:
        clf.fit(X_train, y_train)
        oos = evaluate_model(clf, X_test, y_test, fwd_test)
        _, cl_obs, _ = run_live_observations_benchmark(champion, clf)
        
        # Combined score: 50% OOS edge + 50% Live edge
        score = (oos['dir_win_rate'] + cl_obs['dir_win_rate']) / 2.0
        print(f"\n🧪 {name}:")
        print(f"  • OOS Holdout: BalAcc={oos['balanced_accuracy']*100:.2f}%, DirWin={oos['dir_win_rate']*100:.2f}%, ChopPrec={oos['chop_precision']*100:.2f}%, Edge={oos['avg_dir_edge']:.3f} ATR")
        print(f"  • LIVE Obs:    Acc={cl_obs['accuracy']*100:.2f}%, DirWin={cl_obs['dir_win_rate']*100:.2f}%, Edge={cl_obs['avg_dir_edge']:.3f} ATR, HighSafe={cl_obs['high_safe_avg']*100:.2f}%")
        print(f"  -> Combined DirWin Score: {score*100:.2f}%")
        
        if score > best_score:
            best_score = score
            best_name = name
            best_clf = clf

    print(f"\n🌟 Best Challenger: {best_name} with Combined DirWin: {best_score*100:.2f}%")
    joblib.dump(best_clf, CHALLENGER_PATH)
    print(f"💾 Saved best challenger to {CHALLENGER_PATH}")

if __name__ == '__main__':
    run()
