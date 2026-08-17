// ─── IMPORTS AND SETUP ───────────────────────
require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: '*'
    }
});


// ─── DATABASE CONNECTION ──────────────────────
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);


// ─── TOKEN MANAGEMENT ────────────────────────
let currentToken = {
    value: null,
    createdAt: null,
    expiresAt: null,
    sessionId: null
};

let currentSessionId = null;

function generateToken() {
    const chars =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

    let token = '';

    for (let i = 0; i < 12; i++) {
        token += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    return token;
}

function rotateToken() {
    const now = Date.now();

    currentToken = {
        value: generateToken(),
        createdAt: now,
        expiresAt: now + 17000,
        sessionId: currentSessionId
    };

    io.emit('new-token', {
        token: currentToken.value
    });

    console.log(
        `[${new Date(now).toISOString()}] New QR token: ${currentToken.value}`
    );
}

setInterval(rotateToken, 15000);


// ─── HELPER FUNCTIONS ────────────────────────
function haversineDistance(lat1, lng1, lat2, lng2) {
    const R = 6371000;

    const toRadians = (degrees) => degrees * Math.PI / 180;

    const dLat = toRadians(lat2 - lat1);
    const dLng = toRadians(lng2 - lng1);

    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRadians(lat1)) *
        Math.cos(toRadians(lat2)) *
        Math.sin(dLng / 2) ** 2;

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

function hashDeviceId(deviceString) {
    if (!deviceString) return 0;

    let hash = 0;

    for (let i = 0; i < deviceString.length; i++) {
        hash = ((hash << 5) - hash) + deviceString.charCodeAt(i);
        hash |= 0;
    }

    return Math.abs(hash);
}


// ─── MIDDLEWARE ──────────────────────────────
app.use(cors());
app.use(express.json());


// ─── API ROUTES ──────────────────────────────

// POST /api/login
app.post('/api/login', async (req, res) => {
    try {
        const { email, password, role } = req.body;

        const { data, error } = await supabase
            .from('users')
            .select('id, name, role')
            .eq('email', email)
            .eq('password', password)
            .eq('role', role)
            .maybeSingle();

        if (error) {
            console.error('Login error:', error);
            return res.status(500).json({
                success: false,
                message: 'Server error'
            });
        }

        if (!data) {
            return res.json({
                success: false,
                message: 'Invalid credentials'
            });
        }

        return res.json({
            success: true,
            userId: data.id,
            name: data.name,
            role: data.role
        });

    } catch (error) {
        console.error('Login exception:', error);

        return res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});


// POST /api/session/start
app.post('/api/session/start', async (req, res) => {
    try {
        const {
            teacherId,
            subject,
            classId
        } = req.body;

        const { data, error } = await supabase
            .from('sessions')
            .insert({
                teacher_id: teacherId,
                subject,
                class_id: classId,
                status: 'active'
            })
            .select('id')
            .single();

        if (error) {
            console.error('Session start error:', error);

            return res.status(500).json({
                success: false,
                message: 'Failed to start session'
            });
        }

        currentSessionId = data.id;

        currentToken = {
            value: generateToken(),
            createdAt: Date.now(),
            expiresAt: Date.now() + 17000,
            sessionId: currentSessionId
        };

        io.emit('new-token', {
            token: currentToken.value
        });

        console.log(
            `[${new Date().toISOString()}] Session started: ${currentSessionId}`
        );

        console.log(
            `[${new Date().toISOString()}] Initial QR token: ${currentToken.value}`
        );

        return res.json({
            success: true,
            sessionId: currentSessionId
        });

    } catch (error) {
        console.error('Session start exception:', error);

        return res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});


// POST /api/session/end
app.post('/api/session/end', async (req, res) => {
    try {
        const { sessionId } = req.body;

        const { error } = await supabase
            .from('sessions')
            .update({
                status: 'ended',
                end_time: new Date().toISOString()
            })
            .eq('id', sessionId);

        if (error) {
            console.error('Session end error:', error);

            return res.status(500).json({
                success: false,
                message: 'Failed to end session'
            });
        }

        if (currentSessionId === sessionId) {
            currentSessionId = null;

            currentToken = {
                value: null,
                createdAt: null,
                expiresAt: null,
                sessionId: null
            };
        }

        return res.json({
            success: true
        });

    } catch (error) {
        console.error('Session end exception:', error);

        return res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});


// POST /api/scan
app.post('/api/scan', async (req, res) => {
    try {
        const {
            qr_data,
            student_id,
            lat,
            lng,
            device_id,
            scan_timestamp
        } = req.body;

        // CHECK 1 - Active session exists
        if (!currentSessionId) {
            return res.json({
                success: false,
                message: 'No active class session'
            });
        }

        // CHECK 2 - Token validity
        let qrPayload;

        try {
            qrPayload = typeof qr_data === 'string'
                ? JSON.parse(qr_data)
                : qr_data;
        } catch (error) {
            return res.json({
                success: false,
                message: 'QR expired. Scan again.'
            });
        }

        const token = qrPayload?.token;

        if (!token || token !== currentToken.value) {
            return res.json({
                success: false,
                message: 'QR expired. Scan again.'
            });
        }

        // CHECK 3 - Grace period
        if (Date.now() > currentToken.expiresAt) {
            return res.json({
                success: false,
                message: 'QR expired. Too late.'
            });
        }

        // CHECK 4 - Location validation
        if (
            lat === null ||
            lat === undefined ||
            Number(lat) === 0
        ) {
            return res.json({
                success: false,
                message: 'Enable location access.'
            });
        }

        const classroomLat = parseFloat(process.env.CLASSROOM_LAT);
        const classroomLng = parseFloat(process.env.CLASSROOM_LNG);
        const classroomRadius = parseFloat(process.env.CLASSROOM_RADIUS);

        const studentLat = parseFloat(lat);
        const studentLng = parseFloat(lng);

        const distance = haversineDistance(
            studentLat,
            studentLng,
            classroomLat,
            classroomLng
        );

        if (distance > classroomRadius) {
            return res.json({
                success: false,
                message: 'You are not in classroom.'
            });
        }

        // CHECK 5 - Duplicate attendance
        const {
            data: existingAttendance,
            error: duplicateError
        } = await supabase
            .from('attendance')
            .select('id')
            .eq('student_id', student_id)
            .eq('session_id', currentSessionId)
            .maybeSingle();

        if (duplicateError) {
            console.error('Duplicate check error:', duplicateError);

            return res.status(500).json({
                success: false,
                message: 'Server error'
            });
        }

        if (existingAttendance) {
            return res.json({
                success: false,
                message: 'Already marked present.'
            });
        }

        // CHECK 6 - Device fingerprint threat
        const {
            data: sameDeviceRecords,
            error: deviceError
        } = await supabase
            .from('attendance')
            .select('student_id, device_id')
            .eq('device_id', device_id)
            .eq('session_id', currentSessionId)
            .neq('student_id', student_id);

        if (deviceError) {
            console.error('Device check error:', deviceError);

            return res.status(500).json({
                success: false,
                message: 'Server error'
            });
        }

        if (sameDeviceRecords && sameDeviceRecords.length > 0) {
            await supabase
                .from('threats')
                .insert({
                    session_id: currentSessionId,
                    student_id,
                    device_id,
                    reason: 'Multiple students same device'
                });

            const {
                data: scoreData,
                error: scoreError
            } = await supabase
                .from('scores')
                .select('score')
                .eq('student_id', student_id)
                .maybeSingle();

            if (scoreError) {
                console.error('Score fetch error:', scoreError);
            }

            if (scoreData) {
                const newScore = Math.max(
                    0,
                    Number(scoreData.score || 0) - 10
                );

                const { error: updateScoreError } = await supabase
                    .from('scores')
                    .update({
                        score: newScore,
                        last_updated: new Date().toISOString()
                    })
                    .eq('student_id', student_id);

                if (updateScoreError) {
                    console.error(
                        'Threat score update error:',
                        updateScoreError
                    );
                }
            }

            io.emit('threat-alert', {
                studentId: student_id,
                reason: 'Multiple scans from 1 device',
                timestamp: new Date()
            });

            return res.json({
                success: false,
                message: 'Threat detected. -10 points.',
                pointsDelta: -10
            });
        }

        // ALL CHECKS PASSED

        // Get session start time
        const {
            data: sessionData,
            error: sessionError
        } = await supabase
            .from('sessions')
            .select('start_time')
            .eq('id', currentSessionId)
            .single();

        if (sessionError || !sessionData) {
            console.error('Session fetch error:', sessionError);

            return res.status(500).json({
                success: false,
                message: 'Session not found'
            });
        }

        const sessionStart = new Date(sessionData.start_time).getTime();

        const parsedScanTimestamp =
            scan_timestamp !== undefined && scan_timestamp !== null
                ? new Date(scan_timestamp).getTime()
                : Date.now();

        const effectiveScanTimestamp = Number.isNaN(parsedScanTimestamp)
            ? Date.now()
            : parsedScanTimestamp;

        let pointsDelta = 1;
        let isLate = false;

        if (effectiveScanTimestamp - sessionStart > 300000) {
            pointsDelta = -2;
            isLate = true;
        }

        // Insert attendance
        const {
            error: attendanceError
        } = await supabase
            .from('attendance')
            .insert({
                student_id,
                session_id: currentSessionId,
                lat: studentLat,
                lng: studentLng,
                device_id,
                is_late: isLate,
                points_delta: pointsDelta,
                method: 'qr_scan'
            });

        if (attendanceError) {
            console.error('Attendance insert error:', attendanceError);

            return res.status(500).json({
                success: false,
                message: 'Failed to mark attendance'
            });
        }

        // Update student score
        const {
            data: scoreData,
            error: scoreFetchError
        } = await supabase
            .from('scores')
            .select('score')
            .eq('student_id', student_id)
            .maybeSingle();

        if (scoreFetchError) {
            console.error('Score fetch error:', scoreFetchError);

            return res.status(500).json({
                success: false,
                message: 'Failed to update score'
            });
        }

        if (scoreData) {
            const currentScore = Number(scoreData.score || 0);

            const newScore = Math.max(
                0,
                currentScore + pointsDelta
            );

            const {
                error: scoreUpdateError
            } = await supabase
                .from('scores')
                .update({
                    score: newScore,
                    last_updated: new Date().toISOString()
                })
                .eq('student_id', student_id);

            if (scoreUpdateError) {
                console.error(
                    'Score update error:',
                    scoreUpdateError
                );
            }
        } else {
            const initialScore = Math.max(0, 100 + pointsDelta);

            const {
                error: scoreInsertError
            } = await supabase
                .from('scores')
                .insert({
                    student_id,
                    score: initialScore,
                    last_updated: new Date().toISOString()
                });

            if (scoreInsertError) {
                console.error(
                    'Score insert error:',
                    scoreInsertError
                );
            }
        }

        // Get student name
        const {
            data: studentData,
            error: studentError
        } = await supabase
            .from('users')
            .select('name')
            .eq('id', student_id)
            .maybeSingle();

        if (studentError) {
            console.error('Student fetch error:', studentError);
        }

        const studentName = studentData?.name || 'Student';

        // Emit to all connected clients
        io.emit('student-marked', {
            studentName,
            studentId: student_id,
            pointsDelta,
            timestamp: new Date()
        });

        return res.json({
            success: true,
            message:
                pointsDelta > 0
                    ? 'Present! +1 point'
                    : isLate
                        ? 'Marked late. -2 points'
                        : 'Present!',
            pointsDelta
        });

    } catch (error) {
        console.error('Scan exception:', error);

        return res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});


// GET /api/my-score
app.get('/api/my-score', async (req, res) => {
    try {
        const { studentId } = req.query;

        if (!studentId) {
            return res.status(400).json({
                success: false,
                message: 'studentId is required'
            });
        }

        const {
            data: scoreData,
            error: scoreError
        } = await supabase
            .from('scores')
            .select('score')
            .eq('student_id', studentId)
            .maybeSingle();

        if (scoreError) {
            console.error('Score query error:', scoreError);

            return res.status(500).json({
                success: false,
                message: 'Failed to get score'
            });
        }

        const {
            data: history,
            error: historyError
        } = await supabase
            .from('attendance')
            .select('*')
            .eq('student_id', studentId)
            .order('timestamp', {
                ascending: false
            })
            .limit(5);

        if (historyError) {
            console.error('Attendance history error:', historyError);

            return res.status(500).json({
                success: false,
                message: 'Failed to get attendance history'
            });
        }

        return res.json({
            score: scoreData ? scoreData.score : 100,
            history: history || []
        });

    } catch (error) {
        console.error('My-score exception:', error);

        return res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});


// GET /api/threats
app.get('/api/threats', async (req, res) => {
    try {
        if (!currentSessionId) {
            return res.json([]);
        }

        const {
            data,
            error
        } = await supabase
            .from('threats')
            .select('*')
            .eq('session_id', currentSessionId)
            .order('timestamp', {
                ascending: false
            });

        if (error) {
            console.error('Threats query error:', error);

            return res.status(500).json({
                success: false,
                message: 'Failed to get threats'
            });
        }

        return res.json(data || []);

    } catch (error) {
        console.error('Threats exception:', error);

        return res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});


// ─── SOCKET.IO ───────────────────────────────
io.on('connection', (socket) => {
    console.log('Client connected');

    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});


// ─── SERVER START ────────────────────────────
const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`AttendX backend running on port ${PORT}`);
});