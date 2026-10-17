# ColdChain — Vaccine & Medicine Storage Monitor

**Total Marks:** 100  

---

## Problem Statement
Vaccines and insulin can lose effectiveness when stored outside 2–8°C. Build an IoT cold-chain system that monitors fridge conditions, tracks vaccine heat exposure, maintains safe temperature automatically, and provides a complete web application.

---

## Tasks

### 1. Fridge Node
* Use **ESP32** for two fridges with temperature sensor, door switch, compressor relay, and LED.
* Display temperature and **Safe / Warning / Breach** on OLED.
* Send MQTT data every **5 seconds** and on door-state changes.
* Compressor control logic:
  * **ON** at **7°C**
  * **OFF** at **3°C**
  * **60-second** minimum off-time lock.

---

### 2. Heat-Exposure Budget
* Each batch has a **60-minute budget** above 8°C.
* Track exposure duration and remaining budget.
* Exposure above **12°C** counts **double** (2x rate).
* Budget Status Criteria:
  * **Below 20% remaining:** At Risk.
  * **At 0% remaining:** Discard and hold the red LED **ON** until admin reset.

---

### 3. Power Failure & Offline Mode
* Simulate power failure with a physical/toggle button and report battery/power status.
* Buffer at least **30 minutes** of readings during Wi-Fi loss and sync them sequentially in order without duplicates upon reconnection.
* Trigger a **buzzer** and send an **SMS, Telegram, or Email alert** if the door remains open for over **60 seconds**.

---

### 4. ColdChain Web Application
* **Auth & Roles:** JWT + bcrypt authentication with **Admin**, **Pharmacist**, and **Inspector** roles. Enforce role-based permission checks on the server.
* **Live Dashboard:** Real-time display of temperature, door state, power status, compressor status, and heat-budget status with an intuitive UI.
* **Inventory Management:** Manage vaccine batches and assign or relocate them between fridges.
* **Public QR Check:** Publicly accessible endpoint to display batch **Safe / At Risk / Discard** status and expiry without requiring login authentication.
* **Device Security:** Protect incoming MQTT/HTTP data using **HMAC-SHA256 + timestamp + nonce** verification; reject and log invalid or replayed messages.
* **Tamper-Evident Logs:** Implement a cryptographic **hash chain** for logs with a "Verify Integrity" feature to detect modified or missing records.

---

### 5. AI Breach Prediction & Relocation
* **Temperature Prediction:** Predict fridge temperature **30 minutes ahead** and issue a warning if projected to exceed 8°C.
* **Compressor Health Monitoring:** Detect if compressor performance is degrading and display a **0–100 health score**.
* **Smart Relocation Suggestions:** If a fridge is predicted to become unsafe, automatically recommend which batches to move and specify destination fridges.
* **One-Click Execution:** Allow Pharmacists to approve and execute suggested relocations with a single click.
* **AI Model Report:** Provide a short report documenting the dataset, feature engineering, and model performance results.