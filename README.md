# Q-Chat — Full-stack QKD messaging demo

A local educational prototype with a React/Vite frontend, FastAPI backend, a Qiskit Aer BB84 simulation, QBER estimation, an optional simulated Eve intercept-resend attack, and AES-GCM-encrypted message storage.

## What was fixed in this package

- The backend now accepts local Vite origins on ports such as `5173` **and** `5174` (Vite chooses another port when its default is occupied).
- The 433-qubit BB84 simulation batches Qiskit circuits rather than starting a new Aer simulator for every qubit.
- Key derivation's demo minimum is consistent with the BB84 candidate length produced after sifting and test-bit removal. Previously BB84 could accept a candidate and the crypto function could then reject it, causing key exchange to return HTTP 500.
- Both browser windows poll the exchange status and message history, so the second participant also unlocks chat when the key has been accepted and can see messages from the other side.
- Added the TypeScript configuration and React type declarations needed to build the frontend.

## Important security limitations

This is an educational prototype, not production QKD or a complete secure messaging system. Qiskit simulates measurements locally; there is no physical quantum channel. The backend manages the session key, so this is **not end-to-end encryption against the backend**. The key derivation is a simplified educational construction without a finite-key security proof. Do not use it for sensitive real-world communications.

## Requirements

- Python 3.12 recommended for the provided Windows steps (Python 3.11+ generally works with the requirements).
- Node.js LTS and npm.
- Internet access for the initial Python/npm dependency installation.

## Start the backend (Windows PowerShell)

Open a VS Code terminal:

```powershell
cd backend
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
uvicorn app.main:app --reload
```

If `.venv` already exists, do not recreate it; activate it and start from the `pip install` step. If PowerShell blocks activation, run `Set-ExecutionPolicy -Scope Process Bypass` in that terminal, then activate it again.

API health: http://127.0.0.1:8000/api/health  
API docs: http://127.0.0.1:8000/docs

## Start the frontend

Open a **second terminal** and leave the backend terminal running:

```powershell
cd frontend
npm install
npm run dev
```

Open the exact local URL printed by Vite. It may be `http://localhost:5173/` or `http://localhost:5174/`.

## Use key exchange and chat (two participants required)

1. In browser window A, click **Create Temporary Session**.
2. Copy the session ID displayed in the right security panel.
3. Open the printed frontend URL in a **second browser window or an incognito window**. Click **Join Existing Session**, enter the ID, and click **Join**.
4. Wait until the first window shows the other participant as connected.
5. In either window, click **Start Secure Key Exchange**. Qiskit Aer will simulate the BB84 preparation, basis measurement, sifting, and QBER check.
6. Wait for **Key accepted**. Both windows should unlock chat after they refresh the shared exchange result.
7. Send a message from either window. The other window should show it within about two seconds.
8. Click **Simulate Eve Attack** for a separate intercept-resend demonstration. The measured QBER fluctuates; a run with Eve may be rejected when it exceeds the configured threshold.

Key exchange is intentionally disabled until two participants have joined. Creating a session in only one window is not enough.

## Run backend tests

From `backend/` with the virtual environment activated:

```powershell
pytest -q
```

The BB84 tests run actual Qiskit circuits and may take longer than the encryption tests.
