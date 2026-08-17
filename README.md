# AttendX-backend

Backend API for **AttendX**, a QR-code based smart attendance system. Built with Express and Socket.IO, backed by Supabase (Postgres), it issues rotating QR tokens for live class sessions, validates student check-ins against location and device signals, and pushes real-time updates to connected teacher dashboards.

Pairs with [AttendX-frontend](https://github.com/vuln-code/AttendX-frontend) (student & teacher portals).

## Features

- **Rotating QR tokens** — a random 12-character token is generated per session and auto-rotates every 15 seconds (17-second grace window), broadcast to clients over Socket.IO
- **Geofencing** — validates a scanning student's GPS coordinates against a configured classroom location using the Haversine formula
- **Duplicate-scan prevention** — one attendance record per student per session
- **Device-fingerprint threat detection** — flags and penalizes cases where multiple students check in from the same device fingerprint within a session, and logs them to a `threats` table
- **Credibility scoring** — students start at 100 points; on-time scans add points, late scans and detected threats subtract points
- **Live updates** — Socket.IO events (`new-token`, `student-marked`, `threat-alert`) push real-time state to connected dashboards

## Tech Stack

- [Express 5](https://expressjs.com/) — HTTP API
- [Socket.IO](https://socket.io/) — real-time events
- [Supabase](https://supabase.com/) (`@supabase/supabase-js`) — database (Postgres)
- [qrcode](https://www.npmjs.com/package/qrcode) — QR generation
- [cors](https://www.npmjs.com/package/cors), [dotenv](https://www.npmjs.com/package/dotenv)

## Getting Started

### Prerequisites
- Node.js (v18+ recommended)
- A Supabase project with the tables described below

### Installation

```bash
git clone https://github.com/vuln-code/AttendX-backend.git
cd AttendX-backend
npm install
```

### Environment Variables

Create a `.env` file in the project root:

```env
PORT=3000
SUPABASE_URL=your_supabase_project_url
SUPABASE_KEY=your_supabase_service_or_anon_key
CLASSROOM_LAT=your_classroom_latitude
CLASSROOM_LNG=your_classroom_longitude
CLASSROOM_RADIUS=allowed_radius_in_meters
```

### Run

```bash
npm start
```

The server listens on `0.0.0.0:$PORT` (default `3000`) and logs `AttendX backend running on port <PORT>`.

## Database Schema (Supabase)

The server expects the following tables to already exist:

| Table | Key columns |
|---|---|
| `users` | `id`, `name`, `email`, `password`, `role` |
| `sessions` | `id`, `teacher_id`, `subject`, `class_id`, `status`, `start_time`, `end_time` |
| `attendance` | `student_id`, `session_id`, `lat`, `lng`, `device_id`, `is_late`, `points_delta`, `method`, `timestamp` |
| `scores` | `student_id`, `score`, `last_updated` |
| `threats` | `session_id`, `student_id`, `device_id`, `reason`, `timestamp` |

## API Reference

| Method | Endpoint | Body / Query | Description |
|---|---|---|---|
| `POST` | `/api/login` | `email`, `password`, `role` | Authenticate a student or teacher |
| `POST` | `/api/session/start` | `teacherId`, `subject`, `classId` | Start a class session and begin QR token rotation |
| `POST` | `/api/session/end` | `sessionId` | End a session and clear the active token |
| `POST` | `/api/scan` | `qr_data`, `student_id`, `lat`, `lng`, `device_id`, `scan_timestamp` | Validate a QR scan and mark attendance |
| `GET` | `/api/my-score` | `?studentId=` | Get a student's credibility score and last 5 attendance records |
| `GET` | `/api/threats` | — | List threat records for the current active session |

### `/api/scan` validation order
1. An active session must exist
2. The submitted token must match the current rotating token
3. The token must not be expired (17s grace window)
4. GPS coordinates must be present and within `CLASSROOM_RADIUS` meters of `CLASSROOM_LAT`/`CLASSROOM_LNG`
5. No prior attendance record for that student in the session
6. No other student already checked in from the same `device_id` in the session (flags a threat and applies a -10 point penalty if so)

On success, a scan earns **+1 point** if within 5 minutes of session start, or **-2 points** (marked late) after that.

## Socket.IO Events (server → client)

| Event | Payload | Emitted when |
|---|---|---|
| `new-token` | `{ token }` | A new QR token is generated (session start or rotation) |
| `student-marked` | `{ studentName, studentId, pointsDelta, timestamp }` | A scan is successfully recorded |
| `threat-alert` | `{ studentId, reason, timestamp }` | A device-fingerprint conflict is detected |

## Security Notes

This backend is intended for learning/demo purposes, and a few things should be hardened before any real-world use:
- Passwords are stored and compared as plaintext in `/api/login` — use hashing (e.g. bcrypt) instead
- No session tokens/JWTs are issued after login, and no auth middleware protects the other routes
- CORS is wide open (`origin: '*'`)
- Device fingerprinting is a simple client-supplied hash, not a verifiable identifier — treat it as a heuristic signal, not a security boundary

## License

No license specified yet.