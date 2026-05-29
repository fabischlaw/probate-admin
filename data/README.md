# Data directory — contents excluded from git

This directory holds runtime data files that are environment-specific and must never be committed to version control:

- `administration.json` — matter stage, key dates, task statuses
- `flags.json` — document scanner flags
- `scanHistory.json` — document scanner run history
- `alertHistory.json` — deadline alert run history
- `aiSettings.json` — AI feature toggles
- `users.json` — user accounts (hashed passwords)
- `auditLog.json` — action audit trail
- `sessions.sqlite` — session store

On a fresh deployment, these files are created automatically on first use.
The `data/` directory itself must exist — it is preserved in git via `.gitkeep`.
