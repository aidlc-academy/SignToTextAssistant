import os
import pandas as pd
import numpy as np
from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, classification_report
import joblib

DATASET_PATH = "gesture_dataset.csv"
MODEL_PATH = "gesture_model.pkl"

def train_gesture_model():
    if not os.path.exists(DATASET_PATH):
        print(f"[Error] Dataset not found at {DATASET_PATH}. Please collect data first using collect_data.py.")
        return

    print("[Info] Loading dataset...")
    df = pd.read_csv(DATASET_PATH)

    if df.empty or len(df.columns) < 64:
        print("[Error] Dataset is empty or formatted incorrectly.")
        return

    # Column 0 is the label, columns 1-63 are the 63 landmark coordinates (x, y, z for 21 joints)
    X = df.iloc[:, 1:].values
    y = df.iloc[:, 0].values

    print(f"[Info] Total samples loaded: {len(X)}")
    print(f"[Info] Unique gestures found: {np.unique(y)}")

    # Split dataset into training (80%) and testing (20%) sets
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)

    print("[Info] Training Random Forest Classifier...")
    clf = RandomForestClassifier(n_estimators=100, random_state=42)
    clf.fit(X_train, y_train)

    # Evaluate accuracy
    y_pred = clf.predict(X_test)
    acc = accuracy_score(y_test, y_pred)
    print(f"\n[Success] Model trained successfully!")
    print(f"Test Accuracy: {acc * 100:.2f}%\n")
    print("Classification Report:")
    print(classification_report(y_test, y_pred))

    # Save the trained model
    joblib.dump(clf, MODEL_PATH)
    print(f"[Info] Model saved to {MODEL_PATH}")

if __name__ == "__main__":
    train_gesture_model()