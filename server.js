// ─── IMPORTS AND SETUP ───────────────────────
require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
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
    // Never rotate/emit a QR token when there is no active class.
    if (!currentSessionId) {
        return;
    }

    const now = Date.now();

    currentToken = {
        value: generateToken(),
        createdAt: now,
        expiresAt: now + 17000,
        sessionId: currentSessionId
    };

    io.emit('new-token', {
        token: currentToken.value,
        sessionId: currentSessionId,
        expiresAt: currentToken.expiresAt
    });

    console.log(
        `[${new Date(now).toISOString()}] New QR token for session ${currentSessionId}: ${currentToken.value}`
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
            token: currentToken.value,
            sessionId: currentSessionId,
            expiresAt: currentToken.expiresAt
        });

        io.emit('session-started', {
            sessionId: currentSessionId,
            subject,
            classId
        });

        console.log(
            `[${new Date().toISOString()}] Session started: ${currentSessionId}`
        );

        console.log(
            `[${new Date().toISOString()}] Initial QR token: ${currentToken.value}`
        );

        return res.json({
            success: true,
            sessionId: currentSessionId,
            token: currentToken.value,
            expiresAt: currentToken.expiresAt
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
            io.emit('session-ended', {
                sessionId
            });

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

        if (!student_id || !device_id || !qr_data) {
            return res.status(400).json({
                success: false,
                message: 'Missing scan data.'
            });
        }

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

        if (
            !token ||
            token !== currentToken.value ||
            currentToken.sessionId !== currentSessionId
        ) {
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
        const classroomLat = Number(process.env.CLASSROOM_LAT);
        const classroomLng = Number(process.env.CLASSROOM_LNG);
        const classroomRadius = Number(process.env.CLASSROOM_RADIUS);

        const studentLat = Number(lat);
        const studentLng = Number(lng);

        if (
            !Number.isFinite(studentLat) ||
            !Number.isFinite(studentLng) ||
            (studentLat === 0 && studentLng === 0)
        ) {
            return res.json({
                success: false,
                message: 'Enable location access.'
            });
        }

        if (
            !Number.isFinite(classroomLat) ||
            !Number.isFinite(classroomLng) ||
            !Number.isFinite(classroomRadius) ||
            classroomRadius <= 0
        ) {
            console.error('Invalid classroom location configuration.');
            return res.status(500).json({
                success: false,
                message: 'Classroom location is not configured on the server.'
            });
        }

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
            const threatReason = 'Multiple students same device';

            const { error: threatInsertError } = await supabase
                .from('threats')
                .insert({
                    session_id: currentSessionId,
                    student_id,
                    device_id,
                    reason: threatReason
                });

            if (threatInsertError) {
                console.error('Threat insert error:', threatInsertError);
            }

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
            } else {
                const { error: insertScoreError } = await supabase
                    .from('scores')
                    .insert({
                        student_id,
                        score: 90,
                        last_updated: new Date().toISOString()
                    });

                if (insertScoreError) {
                    console.error(
                        'Threat score insert error:',
                        insertScoreError
                    );
                }
            }

            const {
                data: threatStudent,
                error: threatStudentError
            } = await supabase
                .from('users')
                .select('name')
                .eq('id', student_id)
                .maybeSingle();

            if (threatStudentError) {
                console.error('Threat student fetch error:', threatStudentError);
            }

            io.emit('threat-alert', {
                sessionId: currentSessionId,
                studentId: student_id,
                studentName: threatStudent?.name || 'Student',
                reason: threatReason,
                timestamp: new Date().toISOString()
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

            if (attendanceError.code === '23505') {
                return res.json({
                    success: false,
                    message: 'Already marked present.'
                });
            }

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
            sessionId: currentSessionId,
            studentName,
            studentId: student_id,
            pointsDelta,
            timestamp: new Date().toISOString()
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


// GET /api/session/live
// Returns the current session plus the persisted attendance/threats so the
// teacher dashboard can recover missed Socket.IO events after reconnects.
app.get('/api/session/live', async (req, res) => {
    try {
        const requestedSessionId = req.query.sessionId
            ? String(req.query.sessionId)
            : null;

        if (!currentSessionId) {
            return res.json({
                success: true,
                active: false,
                sessionId: null,
                attendance: [],
                threats: []
            });
        }

        if (
            requestedSessionId &&
            String(currentSessionId) !== requestedSessionId
        ) {
            return res.json({
                success: true,
                active: true,
                sessionId: currentSessionId,
                attendance: [],
                threats: []
            });
        }

        const { data: sessionData, error: sessionError } = await supabase
            .from('sessions')
            .select('id, teacher_id, subject, class_id, start_time, status')
            .eq('id', currentSessionId)
            .maybeSingle();

        if (sessionError) {
            console.error('Live session query error:', sessionError);
            return res.status(500).json({
                success: false,
                message: 'Failed to load session'
            });
        }

        const { data: attendanceRows, error: attendanceError } = await supabase
            .from('attendance')
            .select('id, student_id, session_id, is_late, points_delta, timestamp')
            .eq('session_id', currentSessionId)
            .order('timestamp', { ascending: false });

        if (attendanceError) {
            console.error('Live attendance query error:', attendanceError);
            return res.status(500).json({
                success: false,
                message: 'Failed to load attendance'
            });
        }

        const { data: threatRows, error: threatError } = await supabase
            .from('threats')
            .select('*')
            .eq('session_id', currentSessionId)
            .order('timestamp', { ascending: false });

        if (threatError) {
            console.error('Live threats query error:', threatError);
            return res.status(500).json({
                success: false,
                message: 'Failed to load threats'
            });
        }

        const studentIds = [
            ...new Set(
                (attendanceRows || [])
                    .map(row => row.student_id)
                    .filter(Boolean)
                    .map(String)
            )
        ];

        const { data: students, error: studentsError } =
            studentIds.length > 0
                ? await supabase
                    .from('users')
                    .select('id, name')
                    .in('id', studentIds)
                : { data: [], error: null };

        if (studentsError) {
            console.error('Live student-name query error:', studentsError);
        }

        const studentMap = new Map(
            (students || []).map(student => [
                String(student.id),
                student.name || 'Student'
            ])
        );

        return res.json({
            success: true,
            active: true,
            sessionId: currentSessionId,
            session: sessionData || {
                id: currentSessionId,
                status: 'active'
            },
            attendance: (attendanceRows || []).map(row => ({
                ...row,
                studentName: studentMap.get(String(row.student_id)) || 'Student'
            })),
            threats: threatRows || []
        });
    } catch (error) {
        console.error('Live session exception:', error);
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


// ============================================================
// REPORTS
// ============================================================

// GET /api/reports/attendance
// Teacher-wide attendance matrix across all sessions conducted by the teacher.
app.get('/api/reports/attendance', async (req, res) => {
    try {
        const { teacherId } = req.query;

        if (!teacherId) {
            return res.status(400).json({
                success: false,
                message: 'teacherId is required'
            });
        }

        const { data: sessions, error: sessionError } = await supabase
            .from('sessions')
            .select('id, subject, class_id, start_time, end_time, status')
            .eq('teacher_id', teacherId)
            .order('start_time', { ascending: false });

        if (sessionError) {
            console.error('Attendance report session error:', sessionError);
            return res.status(500).json({
                success: false,
                message: 'Failed to load report sessions'
            });
        }

        const { data: students, error: studentError } = await supabase
            .from('users')
            .select('id, name, email')
            .eq('role', 'student')
            .order('name', { ascending: true });

        if (studentError) {
            console.error('Attendance report student error:', studentError);
            return res.status(500).json({
                success: false,
                message: 'Failed to load students'
            });
        }

        if (!sessions || sessions.length === 0 || !students || students.length === 0) {
            return res.json({
                success: true,
                report: []
            });
        }

        const sessionIds = sessions.map(session => session.id);

        const { data: attendanceRows, error: attendanceError } = await supabase
            .from('attendance')
            .select('id, student_id, session_id, is_late, points_delta, method, timestamp')
            .in('session_id', sessionIds);

        if (attendanceError) {
            console.error('Attendance report attendance error:', attendanceError);
            return res.status(500).json({
                success: false,
                message: 'Failed to load attendance records'
            });
        }

        const attendanceMap = new Map();

        (attendanceRows || []).forEach(row => {
            attendanceMap.set(
                `${String(row.session_id)}::${String(row.student_id)}`,
                row
            );
        });

        const report = [];

        sessions.forEach(session => {
            students.forEach(student => {
                const record = attendanceMap.get(
                    `${String(session.id)}::${String(student.id)}`
                );

                report.push({
                    student_id: student.id,
                    student_name: student.name || 'Unknown',
                    student_email: student.email || '',
                    subject: session.subject || '',
                    class_section: session.class_id || '',
                    session_date: session.start_time || '',
                    attendance_status: record
                        ? (record.is_late ? 'Late' : 'Present')
                        : 'Absent',
                    points_delta: record ? (record.points_delta ?? 0) : 0,
                    method: record?.method || 'Not Marked',
                    marked_at: record?.timestamp || ''
                });
            });
        });

        return res.json({
            success: true,
            report
        });
    } catch (error) {
        console.error('Attendance report exception:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});


// GET /api/reports/student
// Full attendance history for one student across the teacher's sessions.
app.get('/api/reports/student', async (req, res) => {
    try {
        const { teacherId, studentId } = req.query;

        if (!teacherId || !studentId) {
            return res.status(400).json({
                success: false,
                message: 'teacherId and studentId are required'
            });
        }

        const { data: student, error: studentError } = await supabase
            .from('users')
            .select('id, name, email')
            .eq('id', studentId)
            .eq('role', 'student')
            .maybeSingle();

        if (studentError) {
            console.error('Student report user error:', studentError);
            return res.status(500).json({
                success: false,
                message: 'Failed to load student'
            });
        }

        if (!student) {
            return res.status(404).json({
                success: false,
                message: 'Student not found'
            });
        }

        const { data: sessions, error: sessionError } = await supabase
            .from('sessions')
            .select('id, subject, class_id, start_time, end_time, status')
            .eq('teacher_id', teacherId)
            .order('start_time', { ascending: false });

        if (sessionError) {
            console.error('Student report session error:', sessionError);
            return res.status(500).json({
                success: false,
                message: 'Failed to load sessions'
            });
        }

        if (!sessions || sessions.length === 0) {
            return res.json({
                success: true,
                report: []
            });
        }

        const sessionIds = sessions.map(session => session.id);

        const { data: attendanceRows, error: attendanceError } = await supabase
            .from('attendance')
            .select('id, student_id, session_id, is_late, points_delta, method, timestamp')
            .eq('student_id', studentId)
            .in('session_id', sessionIds);

        if (attendanceError) {
            console.error('Student report attendance error:', attendanceError);
            return res.status(500).json({
                success: false,
                message: 'Failed to load student attendance'
            });
        }

        const attendanceMap = new Map(
            (attendanceRows || []).map(row => [String(row.session_id), row])
        );

        const report = sessions.map(session => {
            const record = attendanceMap.get(String(session.id));

            return {
                student_id: student.id,
                student_name: student.name || 'Unknown',
                student_email: student.email || '',
                subject: session.subject || '',
                class_section: session.class_id || '',
                session_date: session.start_time || '',
                attendance_status: record
                    ? (record.is_late ? 'Late' : 'Present')
                    : 'Absent',
                points_delta: record ? (record.points_delta ?? 0) : 0,
                method: record?.method || 'Not Marked',
                marked_at: record?.timestamp || ''
            };
        });

        return res.json({
            success: true,
            report
        });
    } catch (error) {
        console.error('Student report exception:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error'
        });
    }
});


// GET /api/reports/student-behaviour
// Compact analytics summary for a student: attendance, late scans,
// absences, points and recorded security threats.
app.get('/api/reports/student-behaviour', async (req, res) => {
    try {
        const { teacherId, studentId } = req.query;

        if (!teacherId || !studentId) {
            return res.status(400).json({
                success: false,
                message: 'teacherId and studentId are required'
            });
        }

        const { data: student, error: studentError } = await supabase
            .from('users')
            .select('id, name, email')
            .eq('id', studentId)
            .eq('role', 'student')
            .maybeSingle();

        if (studentError) {
            console.error('Behaviour report user error:', studentError);
            return res.status(500).json({
                success: false,
                message: 'Failed to load student'
            });
        }

        if (!student) {
            return res.status(404).json({
                success: false,
                message: 'Student not found'
            });
        }

        const { data: sessions, error: sessionError } = await supabase
            .from('sessions')
            .select('id, subject, class_id, start_time')
            .eq('teacher_id', teacherId)
            .order('start_time', { ascending: false });

        if (sessionError) {
            console.error('Behaviour report session error:', sessionError);
            return res.status(500).json({
                success: false,
                message: 'Failed to load sessions'
            });
        }

        const sessionIds = (sessions || []).map(session => session.id);

        const { data: attendanceRows, error: attendanceError } = sessionIds.length > 0
            ? await supabase
                .from('attendance')
                .select('id, session_id, is_late, points_delta, timestamp')
                .eq('student_id', studentId)
                .in('session_id', sessionIds)
            : { data: [], error: null };

        if (attendanceError) {
            console.error('Behaviour report attendance error:', attendanceError);
            return res.status(500).json({
                success: false,
                message: 'Failed to load attendance history'
            });
        }

        const { data: threatRows, error: threatError } = sessionIds.length > 0
            ? await supabase
                .from('threats')
                .select('id, session_id, reason, timestamp')
                .eq('student_id', studentId)
                .in('session_id', sessionIds)
                .order('timestamp', { ascending: false })
            : { data: [], error: null };

        if (threatError) {
            console.error('Behaviour report threat error:', threatError);
            return res.status(500).json({
                success: false,
                message: 'Failed to load threat history'
            });
        }

        const { data: scoreData, error: scoreError } = await supabase
            .from('scores')
            .select('score')
            .eq('student_id', studentId)
            .maybeSingle();

        if (scoreError) {
            console.error('Behaviour report score error:', scoreError);
        }

        const totalSessions = sessions?.length || 0;
        const attendedSessions = (attendanceRows || []).length;
        const lateSessions = (attendanceRows || [])
            .filter(row => row.is_late).length;
        const absentSessions = Math.max(
            0,
            totalSessions - attendedSessions
        );
        const pointsDelta = (attendanceRows || [])
            .reduce(
                (sum, row) => sum + Number(row.points_delta || 0),
                0
            );
        const attendanceRate = totalSessions > 0
            ? Number(((attendedSessions / totalSessions) * 100).toFixed(2))
            : 0;

        const report = [{
            student_id: student.id,
            student_name: student.name || 'Unknown',
            student_email: student.email || '',
            total_sessions: totalSessions,
            attended_sessions: attendedSessions,
            late_sessions: lateSessions,
            absent_sessions: absentSessions,
            attendance_rate_percent: attendanceRate,
            security_threats: (threatRows || []).length,
            current_credibility_score: scoreData?.score ?? 100,
            net_points_delta: pointsDelta
        }];

        return res.json({
            success: true,
            report
        });
    } catch (error) {
        console.error('Student behaviour report exception:', error);
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
    console.log(
        `[${new Date().toISOString()}] Socket connected: ${socket.id}`
    );

    socket.emit('server-state', {
        active: Boolean(currentSessionId),
        sessionId: currentSessionId
    });

    socket.on('disconnect', (reason) => {
        console.log(
            `[${new Date().toISOString()}] Socket disconnected: ${socket.id} (${reason})`
        );
    });
});


// ─── SERVER START ────────────────────────────
const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`AttendX backend running on port ${PORT}`);
    console.log('LAN access: use http://<THIS-LAPTOP-IP>:' + PORT);
    console.log(
        'Classroom config:',
        {
            lat: process.env.CLASSROOM_LAT,
            lng: process.env.CLASSROOM_LNG,
            radius: process.env.CLASSROOM_RADIUS
        }
    );
});