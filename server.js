const express = require("express");
const { Pool } = require("pg");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const path = require("path");
const webpush = require("web-push");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const http = require("http");
const { Server: SocketIOServer } = require("socket.io");

const app = express();
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: true,
    credentials: true
  }
});

app.set("trust proxy", 1);

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;

if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is missing");
  process.exit(1);
}

if (!ADMIN_PASSWORD) {
  console.error("ERROR: ADMIN_PASSWORD is missing");
  process.exit(1);
}

if (!JWT_SECRET) {
  console.error("ERROR: JWT_SECRET is missing");
  process.exit(1);
}

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());

/* =========================================================
   🔴 LIVE VIDEO / WEBRTC SIGNALING
   The video itself travels directly between the broadcaster
   and viewers with WebRTC. Socket.IO is only used for
   signaling, so no video files are stored on the server.
========================================================= */

const liveBroadcasters = new Map(); // matchId -> socket.id
const liveSockets = new Map();      // socket.id -> Set(matchId)

function socketAdmin(socket) {
  try {
    const raw = String(
      socket.handshake?.headers?.cookie || ""
    );
    const found = raw.match(
      /(?:^|;\s*)aliscore_admin=([^;]+)/
    );
    if (!found) return null;

    const token = decodeURIComponent(found[1]);
    return verifyAdminToken(token);
  } catch (_) {
    return null;
  }
}

function liveRoom(matchId) {
  return `live:${Number(matchId)}`;
}

function rememberLiveSocket(socket, matchId) {
  const id = Number(matchId);
  if (!Number.isFinite(id)) return;
  if (!liveSockets.has(socket.id)) {
    liveSockets.set(socket.id, new Set());
  }
  liveSockets.get(socket.id).add(id);
}

function forgetLiveSocket(socket, matchId) {
  const set = liveSockets.get(socket.id);
  if (!set) return;
  set.delete(Number(matchId));
  if (!set.size) liveSockets.delete(socket.id);
}

io.on("connection", (socket) => {
  socket.on("live:start", async (payload = {}, ack = () => {}) => {
    try {
      const admin = socketAdmin(socket);
      if (!admin) {
        return ack({
          ok: false,
          error: "Admin Login required"
        });
      }

      const matchId = Number(payload.matchId);
      if (!Number.isInteger(matchId) || matchId <= 0) {
        return ack({
          ok: false,
          error: "Matç tapılmadı"
        });
      }

      const matchResult = await query(
        "SELECT id, status FROM matches WHERE id = $1",
        [matchId]
      );

      if (!matchResult.rows.length) {
        return ack({
          ok: false,
          error: "Matç tapılmadı"
        });
      }

      const oldBroadcaster = liveBroadcasters.get(matchId);
      if (oldBroadcaster && oldBroadcaster !== socket.id) {
        return ack({
          ok: false,
          error: "Bu matç üçün artıq canlı yayım açılıb"
        });
      }

      liveBroadcasters.set(matchId, socket.id);
      socket.join(liveRoom(matchId));
      rememberLiveSocket(socket, matchId);

      io.to(liveRoom(matchId)).emit("live:started", {
        matchId,
        broadcasterId: socket.id
      });

      ack({
        ok: true,
        matchId,
        viewers: io.sockets.adapter.rooms.get(liveRoom(matchId))?.size || 1
      });
    } catch (err) {
      console.error("LIVE START ERROR:", err);
      ack({
        ok: false,
        error: err.message || "Canlı yayım başlatılmadı"
      });
    }
  });

  socket.on("live:stop", (payload = {}, ack = () => {}) => {
    const matchId = Number(payload.matchId);
    if (!Number.isInteger(matchId)) {
      return ack({ ok: false, error: "Matç tapılmadı" });
    }

    if (liveBroadcasters.get(matchId) !== socket.id) {
      return ack({
        ok: false,
        error: "Bu canlı yayımı siz başlamamısınız"
      });
    }

    liveBroadcasters.delete(matchId);
    io.to(liveRoom(matchId)).emit("live:ended", {
      matchId
    });
    socket.leave(liveRoom(matchId));
    forgetLiveSocket(socket, matchId);

    ack({ ok: true });
  });

  socket.on("live:join", (payload = {}, ack = () => {}) => {
    const matchId = Number(payload.matchId);
    if (!Number.isInteger(matchId) || matchId <= 0) {
      return ack({
        ok: false,
        available: false,
        error: "Matç tapılmadı"
      });
    }

    socket.join(liveRoom(matchId));
    rememberLiveSocket(socket, matchId);

    const broadcasterId = liveBroadcasters.get(matchId);

    if (!broadcasterId) {
      return ack({
        ok: true,
        available: false,
        matchId
      });
    }

    io.to(broadcasterId).emit("live:viewer-joined", {
      matchId,
      viewerId: socket.id
    });

    socket.emit("live:broadcaster", {
      matchId,
      broadcasterId
    });

    const viewers = Math.max(0, (io.sockets.adapter.rooms.get(liveRoom(matchId))?.size || 1) - 1);
    io.to(broadcasterId).emit("live:viewer-count", { matchId, viewers });

    ack({
      ok: true,
      available: true,
      matchId,
      broadcasterId,
      viewers
    });
  });

  socket.on("live:leave", (payload = {}) => {
    const matchId = Number(payload.matchId);
    if (!Number.isInteger(matchId)) return;

    const broadcasterId = liveBroadcasters.get(matchId);
    if (broadcasterId && broadcasterId !== socket.id) {
        io.to(broadcasterId).emit("live:viewer-left", {
        matchId,
        viewerId: socket.id
      });
    }

    socket.leave(liveRoom(matchId));
    forgetLiveSocket(socket, matchId);

    const broadcaster = liveBroadcasters.get(matchId);
    if (broadcaster) {
      const viewers = Math.max(0, (io.sockets.adapter.rooms.get(liveRoom(matchId))?.size || 1) - 1);
      io.to(broadcaster).emit("live:viewer-count", { matchId, viewers });
    }
  });

  socket.on("live:signal", (payload = {}) => {
    const to = String(payload.to || "");
    const matchId = Number(payload.matchId);
    if (!to || !payload.data || !Number.isInteger(matchId)) return;

    const room = liveRoom(matchId);
    const targetRoom = io.sockets.adapter.rooms.get(room);
    if (!targetRoom || !targetRoom.has(to)) return;

    io.to(to).emit("live:signal", {
      from: socket.id,
      matchId,
      data: payload.data
    });
  });

  socket.on("disconnect", () => {
    const matchesForSocket = liveSockets.get(socket.id);
    if (!matchesForSocket) return;

    for (const matchId of matchesForSocket) {
      if (liveBroadcasters.get(matchId) === socket.id) {
        // A socket disconnect is NOT the same thing as the admin ending the
        // broadcast. Mobile Safari/Chrome can briefly drop a WebSocket when
        // the phone changes network, locks the screen, or wakes from sleep.
        // Keep the match in LIVE state so viewers wait for the broadcaster
        // to reconnect instead of seeing a false "Canlı yayım bitib.".
        liveBroadcasters.delete(matchId);
        io.to(liveRoom(matchId)).emit("live:waiting", {
          matchId
        });
      } else {
        const broadcasterId = liveBroadcasters.get(matchId);
        if (broadcasterId) {
          io.to(broadcasterId).emit("live:viewer-left", {
            matchId,
            viewerId: socket.id
          });
          const viewers = Math.max(0, (io.sockets.adapter.rooms.get(liveRoom(matchId))?.size || 1) - 1);
          io.to(broadcasterId).emit("live:viewer-count", { matchId, viewers });
        }
      }
    }

    liveSockets.delete(socket.id);
  });
});

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

/* =========================================================
   VAPID / PUSH
========================================================= */

const VAPID_PUBLIC_KEY = String(
  process.env.VAPID_PUBLIC_KEY || ""
).trim();

const VAPID_PRIVATE_KEY = String(
  process.env.VAPID_PRIVATE_KEY || ""
).trim();

let VAPID_SUBJECT = String(
  process.env.VAPID_EMAIL ||
  process.env.VAPID_SUBJECT ||
  ""
).trim();

if (
  VAPID_SUBJECT &&
  !VAPID_SUBJECT.startsWith("mailto:") &&
  !VAPID_SUBJECT.startsWith("http://") &&
  !VAPID_SUBJECT.startsWith("https://")
) {
  VAPID_SUBJECT = `mailto:${VAPID_SUBJECT}`;
}

if (!VAPID_SUBJECT) {
  VAPID_SUBJECT = "mailto:aliscore@example.com";
}

let pushEnabled = false;
let lastPushResult = {
  at: null, title: null, body: null, total: 0, sent: 0, failed: 0, removed: 0,
  errors: []
};

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(
      VAPID_SUBJECT,
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY
    );

    pushEnabled = true;

    console.log("Web Push: enabled");
    console.log("VAPID subject:", VAPID_SUBJECT);
  } catch (err) {
    pushEnabled = false;

    console.error(
      "Web Push configuration error:",
      err.message
    );
  }
} else {
  console.log(
    "Web Push: disabled - VAPID keys missing"
  );
}

/* =========================================================
   HELPERS
========================================================= */

function cleanString(value) {
  if (
    value === undefined ||
    value === null
  ) {
    return "";
  }

  return String(value).trim();
}

function intValue(value, fallback = 0) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return fallback;
  }

  return Math.trunc(n);
}

function nullableInt(value) {
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    value === "null"
  ) {
    return null;
  }

  const n = Number(value);

  if (!Number.isFinite(n)) {
    return null;
  }

  return Math.trunc(n);
}

function numberValue(value, fallback = 0) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return fallback;
  }

  return n;
}

async function query(text, params = []) {
  return pool.query(text, params);
}

function eventStatColumn(type) {
  const map = {
    goal: "goals",
    assist: "assists",
    save: "saves",
    yellow: "yellow_cards",
    red: "red_cards",
    own_goal: "own_goals"
  };

  return map[type] || null;
}

function eventRatingDelta(type) {
  const map = {
    goal: 1,
    assist: 0.5,
    save: 0.5,
    yellow: -1,
    red: -3,
    own_goal: -2
  };
  return Number(map[type] || 0);
}

async function changePlayerRating(db, playerId, delta) {
  if (!playerId || !delta) return;
  await db.query(
    `UPDATE players SET rating = COALESCE(rating,0) + $1 WHERE id = $2`,
    [delta, playerId]
  );
}

async function createNotification(
  type,
  title,
  body,
  data = {}
) {
  try {
    await query(
      `
        INSERT INTO notifications
          (type, title, body, data)
        VALUES
          ($1, $2, $3, $4)
      `,
      [
        type,
        title,
        body,
        JSON.stringify(data || {})
      ]
    );
  } catch (err) {
    console.error(
      "Notification create error:",
      err.message
    );
  }
}

async function sendPush(title, body, data = {}) {
  const resultInfo = {
    enabled: pushEnabled,
    total: 0,
    sent: 0,
    removed: 0,
    failed: 0,
    errors: []
  };
  if (!pushEnabled) {
    resultInfo.error = "VAPID is not configured";
    lastPushResult = { ...resultInfo, at: new Date().toISOString(), title, body };
    return resultInfo;
  }

  let subscriptions;
  try {
    const result = await query(`SELECT id, endpoint, p256dh, auth FROM push_subscriptions`);
    subscriptions = result.rows;
  } catch (err) {
    console.error("Push subscriptions read error:", err.message);
    resultInfo.error = err.message;
    lastPushResult = { ...resultInfo, at: new Date().toISOString(), title, body };
    return resultInfo;
  }

  resultInfo.total = subscriptions.length;
  const payload = JSON.stringify({ title, body, data });

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth }
        },
        payload,
        {
          TTL: 86400,
          urgency: "high"
        }
      );
      resultInfo.sent++;
    } catch (err) {
      resultInfo.failed++;
      const pushError = {
        statusCode: err.statusCode || null,
        message: err.message || "Push send failed",
        body: err.body || null,
        endpoint: String(sub.endpoint || "").slice(0, 100)
      };
      resultInfo.errors.push(pushError);
      console.error("Push send error:", pushError);
      if (err.statusCode === 404 || err.statusCode === 410) {
        try {
          await query(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id]);
          resultInfo.removed++;
        } catch (deleteErr) {
          console.error("Old push subscription delete error:", deleteErr.message);
        }
      }
    }
  }
  lastPushResult = {
    ...resultInfo,
    at: new Date().toISOString(),
    title,
    body,
    errors: resultInfo.errors.slice(0, 10)
  };
  return resultInfo;
}

async function notify(
  type,
  title,
  body,
  data = {}
) {
  await createNotification(
    type,
    title,
    body,
    data
  );

  return await sendPush(
    title,
    body,
    data
  );
}

/* =========================================================
   DATABASE
========================================================= */

async function initDatabase() {
  await query(`CREATE TABLE IF NOT EXISTS site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')`);
  await query(`INSERT INTO site_settings(key,value) VALUES ('maintenance_mode','off') ON CONFLICT (key) DO NOTHING`);
  await query(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id BIGSERIAL PRIMARY KEY,
      action TEXT NOT NULL DEFAULT 'Admin əməliyyatı',
      method TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL DEFAULT '',
      status_code INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS admin_undo_snapshots (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      snapshot JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS teams (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      logo TEXT DEFAULT '',
      captain TEXT DEFAULT '',
      points INTEGER NOT NULL DEFAULT 0,
      played INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      draws INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      goals_for INTEGER NOT NULL DEFAULT 0,
      goals_against INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      number INTEGER DEFAULT 0,
      position TEXT DEFAULT '',
      photo TEXT DEFAULT '',
      goals INTEGER NOT NULL DEFAULT 0,
      assists INTEGER NOT NULL DEFAULT 0,
      saves INTEGER NOT NULL DEFAULT 0,
      yellow_cards INTEGER NOT NULL DEFAULT 0,
      red_cards INTEGER NOT NULL DEFAULT 0,
      rating NUMERIC DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    ALTER TABLE players ADD COLUMN IF NOT EXISTS own_goals INTEGER NOT NULL DEFAULT 0
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS player_availability (
      id SERIAL PRIMARY KEY,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('injury','suspension')),
      reason TEXT NOT NULL DEFAULT '',
      return_date DATE,
      matches_remaining INTEGER NOT NULL DEFAULT 0 CHECK (matches_remaining >= 0),
      notes TEXT NOT NULL DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_player_availability_active ON player_availability(active, player_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS ballondor_snapshots (
      id SERIAL PRIMARY KEY,
      season INTEGER NOT NULL UNIQUE,
      finalized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finalized_by TEXT DEFAULT '',
      scoring_rules JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS ballondor_snapshot_players (
      snapshot_id INTEGER NOT NULL REFERENCES ballondor_snapshots(id) ON DELETE CASCADE,
      player_id INTEGER,
      player_name TEXT NOT NULL,
      team_name TEXT DEFAULT '',
      rank INTEGER NOT NULL,
      score NUMERIC NOT NULL DEFAULT 0,
      goals INTEGER NOT NULL DEFAULT 0,
      assists INTEGER NOT NULL DEFAULT 0,
      saves INTEGER NOT NULL DEFAULT 0,
      own_goals INTEGER NOT NULL DEFAULT 0,
      yellow_cards INTEGER NOT NULL DEFAULT 0,
      red_cards INTEGER NOT NULL DEFAULT 0,
      mvp_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(snapshot_id, rank)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS matches (
      id SERIAL PRIMARY KEY,
      home_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      away_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      home_score INTEGER NOT NULL DEFAULT 0,
      away_score INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'scheduled',
      match_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      venue TEXT DEFAULT '',
      player_of_match_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS champions_league_matches (
      id SERIAL PRIMARY KEY,
      home_team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      away_team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      home_score INTEGER,
      away_score INTEGER,
      status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','finished')),
      leg INTEGER NOT NULL DEFAULT 1,
      round_no INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (home_team_id <> away_team_id),
      UNIQUE(home_team_id, away_team_id, leg)
    )
  `);
  await query(`ALTER TABLE champions_league_matches ADD COLUMN IF NOT EXISTS round_no INTEGER NOT NULL DEFAULT 1`);
  await query(`
    CREATE TABLE IF NOT EXISTS champions_league_final (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      home_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      away_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      home_score INTEGER,
      away_score INTEGER,
      status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','finished')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`INSERT INTO champions_league_final(id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

  // Independent Champions League player statistics and eight-player team of the week.
  await query(`
    CREATE TABLE IF NOT EXISTS champions_league_player_stats (
      player_id INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
      goals INTEGER NOT NULL DEFAULT 0 CHECK (goals >= 0),
      assists INTEGER NOT NULL DEFAULT 0 CHECK (assists >= 0),
      saves INTEGER NOT NULL DEFAULT 0 CHECK (saves >= 0),
      own_goals INTEGER NOT NULL DEFAULT 0 CHECK (own_goals >= 0),
      yellow_cards INTEGER NOT NULL DEFAULT 0 CHECK (yellow_cards >= 0),
      red_cards INTEGER NOT NULL DEFAULT 0 CHECK (red_cards >= 0),
      appearances INTEGER NOT NULL DEFAULT 0 CHECK (appearances >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS champions_league_team_of_week (
      id SERIAL PRIMARY KEY,
      week TEXT NOT NULL,
      player_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS match_events (
      id SERIAL PRIMARY KEY,
      match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      minute INTEGER DEFAULT 0,
      note TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      type TEXT DEFAULT '',
      title TEXT NOT NULL,
      body TEXT DEFAULT '',
      data JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS team_of_week (
      id SERIAL PRIMARY KEY,
      week TEXT NOT NULL,
      goalkeeper_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      defender_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      midfielder_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      attacker_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS team_of_week_players (
      id SERIAL PRIMARY KEY,
      team_of_week_id INTEGER NOT NULL REFERENCES team_of_week(id) ON DELETE CASCADE,
      player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      position TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS lineup_players (
      id SERIAL PRIMARY KEY,
      match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      position TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS lineups (
      id SERIAL PRIMARY KEY,
      match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      goalkeeper_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      defenders JSONB DEFAULT '[]'::jsonb,
      midfielders JSONB DEFAULT '[]'::jsonb,
      attackers JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS transfers (
      id SERIAL PRIMARY KEY,
      player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      from_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      to_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      note TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);



  await query(`
    ALTER TABLE transfers
    ADD COLUMN IF NOT EXISTS fee NUMERIC NOT NULL DEFAULT 0
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Compatibility migration for existing databases created with an older
  // push_subscriptions schema. CREATE TABLE IF NOT EXISTS does not add
  // columns to an already-existing table.
  await query(`
    ALTER TABLE push_subscriptions
    ADD COLUMN IF NOT EXISTS endpoint TEXT
  `);

  await query(`
    ALTER TABLE push_subscriptions
    ADD COLUMN IF NOT EXISTS p256dh TEXT
  `);

  await query(`
    ALTER TABLE push_subscriptions
    ADD COLUMN IF NOT EXISTS auth TEXT
  `);

  // The subscribe route uses ON CONFLICT (endpoint), so make sure an
  // existing database also has a unique index for that column.
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_key
    ON push_subscriptions(endpoint)
  `);

  /* =======================================================
     TEAMS COMPATIBILITY
  ======================================================= */

  await query(`
    ALTER TABLE teams
    ADD COLUMN IF NOT EXISTS logo TEXT DEFAULT ''
  `);

  await query(`
    ALTER TABLE teams
    ADD COLUMN IF NOT EXISTS captain TEXT DEFAULT ''
  `);

  await query(`
    ALTER TABLE teams
    ADD COLUMN IF NOT EXISTS points INTEGER NOT NULL DEFAULT 0
  `);

  await query(`
    ALTER TABLE teams
    ADD COLUMN IF NOT EXISTS played INTEGER NOT NULL DEFAULT 0
  `);

  await query(`
    ALTER TABLE teams
    ADD COLUMN IF NOT EXISTS wins INTEGER NOT NULL DEFAULT 0
  `);

  await query(`
    ALTER TABLE teams
    ADD COLUMN IF NOT EXISTS draws INTEGER NOT NULL DEFAULT 0
  `);

  await query(`
    ALTER TABLE teams
    ADD COLUMN IF NOT EXISTS losses INTEGER NOT NULL DEFAULT 0
  `);

  await query(`
    ALTER TABLE teams
    ADD COLUMN IF NOT EXISTS goals_for INTEGER NOT NULL DEFAULT 0
  `);

  await query(`
    ALTER TABLE teams
    ADD COLUMN IF NOT EXISTS goals_against INTEGER NOT NULL DEFAULT 0
  `);

  /* =======================================================
     PLAYERS COMPATIBILITY
  ======================================================= */

  await query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS team_id INTEGER
  `);

  try {
    await query(`
      ALTER TABLE players
      ADD CONSTRAINT players_team_id_fkey
      FOREIGN KEY (team_id)
      REFERENCES teams(id)
      ON DELETE SET NULL
    `);
  } catch (err) {
    if (
      !String(err.message || "")
        .toLowerCase()
        .includes("already exists")
    ) {
      console.log(
        "players_team_id_fkey:",
        err.message
      );
    }
  }

  await query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS name TEXT DEFAULT ''
  `);

  await query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS number INTEGER DEFAULT 0
  `);

  await query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS position TEXT DEFAULT ''
  `);

  await query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS photo TEXT DEFAULT ''
  `);

  await query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS goals INTEGER NOT NULL DEFAULT 0
  `);

  await query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS assists INTEGER NOT NULL DEFAULT 0
  `);

  await query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS saves INTEGER NOT NULL DEFAULT 0
  `);

  await query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS yellow_cards INTEGER NOT NULL DEFAULT 0
  `);

  await query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS red_cards INTEGER NOT NULL DEFAULT 0
  `);

  await query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS rating NUMERIC DEFAULT 0
  `);

  await query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS own_goals INTEGER NOT NULL DEFAULT 0
  `);

  await query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS transfer_value NUMERIC NOT NULL DEFAULT 0
  `);

  await query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS mvp_count INTEGER NOT NULL DEFAULT 0
  `);



  try {
    await query(`
      ALTER TABLE players
      ALTER COLUMN rating TYPE NUMERIC
      USING COALESCE(rating, 0)::NUMERIC
    `);
  } catch (err) {
    console.log(
      "Rating type compatibility:",
      err.message
    );
  }

  /* =======================================================
     MATCHES COMPATIBILITY
  ======================================================= */

  await query(`
    ALTER TABLE matches
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'scheduled'
  `);

  await query(`
    ALTER TABLE matches
    ADD COLUMN IF NOT EXISTS match_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  `);

  await query(`
    ALTER TABLE matches
    ADD COLUMN IF NOT EXISTS venue TEXT DEFAULT ''
  `);

  await query(`
    ALTER TABLE matches
    ADD COLUMN IF NOT EXISTS player_of_match_id INTEGER
  `);

  try {
    await query(`
      ALTER TABLE matches
      ADD CONSTRAINT matches_player_of_match_fk
      FOREIGN KEY (player_of_match_id)
      REFERENCES players(id)
      ON DELETE SET NULL
    `);
  } catch (err) {
    if (!String(err.message || "").includes("already exists")) {
      console.log("Player of match FK compatibility:", err.message);
    }
  }

  /* =======================================================
     TEAM OF THE WEEK COMPATIBILITY
  ======================================================= */

  await query(`
    ALTER TABLE team_of_week
    ADD COLUMN IF NOT EXISTS week TEXT
  `);

  await query(`
    ALTER TABLE team_of_week
    ADD COLUMN IF NOT EXISTS goalkeeper_id INTEGER
  `);

  await query(`
    ALTER TABLE team_of_week
    ADD COLUMN IF NOT EXISTS defender_id INTEGER
  `);

  await query(`
    ALTER TABLE team_of_week
    ADD COLUMN IF NOT EXISTS midfielder_id INTEGER
  `);

  await query(`
    ALTER TABLE team_of_week
    ADD COLUMN IF NOT EXISTS attacker_id INTEGER
  `);

  // Older AliScore databases may have team_of_week without created_at.
  // The API sorts the latest Team of the Week by this column, so make sure
  // the column exists before any /api/state or /api/team-of-week request.
  await query(`
    ALTER TABLE team_of_week
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  `);

  await query(`
    ALTER TABLE team_of_week_players
    ADD COLUMN IF NOT EXISTS team_of_week_id INTEGER
  `);

  await query(`
    ALTER TABLE team_of_week_players
    ADD COLUMN IF NOT EXISTS player_id INTEGER
  `);

  await query(`
    ALTER TABLE team_of_week_players
    ADD COLUMN IF NOT EXISTS position TEXT DEFAULT ''
  `);

  /* =======================================================
     EVENTS COMPATIBILITY
  ======================================================= */

  await query(`
    ALTER TABLE match_events
    ADD COLUMN IF NOT EXISTS team_id INTEGER
  `);

  await query(`
    ALTER TABLE match_events
    ADD COLUMN IF NOT EXISTS player_id INTEGER
  `);

  await query(`
    ALTER TABLE match_events
    ADD COLUMN IF NOT EXISTS type TEXT DEFAULT ''
  `);

  await query(`
    ALTER TABLE match_events
    ADD COLUMN IF NOT EXISTS minute INTEGER DEFAULT 0
  `);

  await query(`
    ALTER TABLE match_events
    ADD COLUMN IF NOT EXISTS note TEXT DEFAULT ''
  `);

  /* =======================================================
     USER ACCOUNTS
  ======================================================= */

  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      email VARCHAR(150) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  /* =======================================================
     HƏFTƏNİN QOLU
  ======================================================= */

  await query(`
    CREATE TABLE IF NOT EXISTS goal_week_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      closed BOOLEAN NOT NULL DEFAULT FALSE,
      winner_candidate_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS goal_week_candidates (
      id SERIAL PRIMARY KEY,
      player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
      video_url TEXT DEFAULT '',
      description TEXT DEFAULT '',
      votes INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS goal_week_votes (
      id SERIAL PRIMARY KEY,
      candidate_id INTEGER NOT NULL REFERENCES goal_week_candidates(id) ON DELETE CASCADE,
      voter_key TEXT NOT NULL UNIQUE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    INSERT INTO goal_week_settings (id, closed)
    VALUES (1, FALSE)
    ON CONFLICT (id) DO NOTHING
  `);

  await seedData();

  console.log("Database initialized");
}

/* =========================================================
   SEED
========================================================= */

async function seedData() {
  const teams = [
    "Xirdalan United",
    "Xirdalan Wolves",
    "Neweli FK",
    "MSN FK",
    "Lotu pişiklər"
  ];

  for (const name of teams) {
    await query(
      `
        INSERT INTO teams (name)
        VALUES ($1)
        ON CONFLICT (name) DO NOTHING
      `,
      [name]
    );
  }

  const teamRows = await query(
    `
      SELECT id, name
      FROM teams
      WHERE name = ANY($1)
    `,
    [teams]
  );

  const teamMap = {};

  for (const row of teamRows.rows) {
    teamMap[row.name] = row.id;
  }

  const captains = {
    "Xirdalan United": "Amil",
    "Xirdalan Wolves": "Ali",
    "Lotu pişiklər": "Kamran",
    "MSN FK": "Fuad",
    "Neweli FK": "Tofik"
  };

  for (const [teamName, captain] of Object.entries(captains)) {
    const teamId = teamMap[teamName];
    if (teamId) {
      await query(
        `UPDATE teams SET captain = $1 WHERE id = $2`,
        [captain, teamId]
      );
    }
  }

  const seedPlayers = [
    ["Xirdalan Wolves", "Ali", 1, "Qapıçı"],
    ["Xirdalan Wolves", "Emin", 2, "Müdafiə"],
    ["Xirdalan Wolves", "Huseyin", 3, "Müdafiə"],
    ["Xirdalan Wolves", "Raul", 4, "Hücum"],

    ["Xirdalan United", "Amil", 1, "Qapıçı"],
    ["Xirdalan United", "Elmir", 2, "Müdafiə"],
    ["Xirdalan United", "İsa", 3, "Yarımmüdafiə"],
    ["Xirdalan United", "Ümüd", 4, "Hücum"],
    ["Xirdalan United", "Huseyin", 5, "Müdafiə"],

    ["MSN FK", "Fuad", 1, "Qapıçı"],
    ["MSN FK", "Murad", 2, "Müdafiə"],

    ["Neweli FK", "Tofik", 1, "Qapıçı"],
    ["Neweli FK", "Arda", 2, "Müdafiə"],
    ["Neweli FK", "Veli", 3, "Yarımmüdafiə"],
    ["Neweli FK", "Emil", 4, "Hücum"],

    ["Lotu pişiklər", "Kamran", 1, "Qapıçı"],
    ["Lotu pişiklər", "Ayxan", 2, "Müdafiə"],
    ["Lotu pişiklər", "Ramil", 3, "Hücum"]
  ];

  for (const item of seedPlayers) {
    const teamName = item[0];
    const playerName = item[1];
    const number = item[2];
    const position = item[3];

    const teamId = teamMap[teamName];

    if (!teamId) continue;

    const exists = await query(
      `
        SELECT id
        FROM players
        WHERE team_id = $1
          AND LOWER(name) = LOWER($2)
        LIMIT 1
      `,
      [teamId, playerName]
    );

    if (!exists.rows.length) {
      await query(
        `
          INSERT INTO players
            (
              team_id,
              name,
              number,
              position
            )
          VALUES
            ($1, $2, $3, $4)
        `,
        [
          teamId,
          playerName,
          number,
          position
        ]
      );
    }
  }
}

/* =========================================================
   BASIC
========================================================= */

app.get("/api/live/ice", (req, res) => {
  const urls = String(process.env.TURN_URLS || process.env.TURN_URL || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);
  const servers = [];
  if (urls.length) {
    const item = { urls };
    const username = String(process.env.TURN_USERNAME || "").trim();
    const credential = String(process.env.TURN_CREDENTIAL || "").trim();
    if (username) item.username = username;
    if (credential) item.credential = credential;
    servers.push(item);
  }
  res.json({ ok: true, servers });
});

app.get("/api/health", async (req, res) => {
  try {
    await query("SELECT 1");

    let subscriptions = 0;

    try {
      const result = await query(`
        SELECT COUNT(*)::int AS count
        FROM push_subscriptions
      `);
      subscriptions = result.rows[0]?.count || 0;
    } catch (_) {}

    res.json({
      ok: true,
      server: true,
      database: "connected",
      push: {
        enabled: pushEnabled,
        configured: !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY),
        subscriptions
      },
      time: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      server: true,
      database: "error",
      push: {
        enabled: pushEnabled,
        configured: !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY)
      },
      error: err.message
    });
  }
});

/* =========================================================
   STATE
========================================================= */

app.get("/api/state", async (req, res) => {
  try {
    const [
      teams,
      players,
      matches,
      events,
      notifications,
      transfers,
      teamOfWeek
    ] = await Promise.all([
      query(`
        SELECT
          t.*,
          (
            t.goals_for -
            t.goals_against
          ) AS goal_difference
        FROM teams t
        ORDER BY
          t.points DESC,
          (
            t.goals_for -
            t.goals_against
          ) DESC,
          t.goals_for DESC,
          t.name ASC
      `),

      query(`
        SELECT
          p.*,
          t.name AS team_name
        FROM players p
        LEFT JOIN teams t
          ON t.id = p.team_id
        ORDER BY
          t.name ASC,
          p.number ASC,
          p.name ASC
      `),

      query(`
        SELECT
          m.*,
          ht.name AS home_team_name,
          ht.logo AS home_team_logo,
          at.name AS away_team_name,
          at.logo AS away_team_logo
        FROM matches m
        LEFT JOIN teams ht
          ON ht.id = m.home_team_id
        LEFT JOIN teams at
          ON at.id = m.away_team_id
        ORDER BY
          m.match_date DESC,
          m.id DESC
      `),

      query(`
        SELECT
          e.*,
          p.name AS player_name,
          p.photo AS player_photo,
          t.name AS team_name
        FROM match_events e
        LEFT JOIN players p
          ON p.id = e.player_id
        LEFT JOIN teams t
          ON t.id = e.team_id
        ORDER BY
          e.created_at DESC,
          e.id DESC
      `),

      query(`
        SELECT *
        FROM notifications
        ORDER BY
          created_at DESC,
          id DESC
        LIMIT 100
      `),

      query(`
        SELECT
          tr.*,
          p.name AS player_name,
          ft.name AS from_team_name,
          tt.name AS to_team_name
        FROM transfers tr
        LEFT JOIN players p
          ON p.id = tr.player_id
        LEFT JOIN teams ft
          ON ft.id = tr.from_team_id
        LEFT JOIN teams tt
          ON tt.id = tr.to_team_id
        ORDER BY
          tr.created_at DESC,
          tr.id DESC
        LIMIT 100
      `),

      query(`
        SELECT
          tw.*,
          gp.name AS goalkeeper_name,
          dp.name AS defender_name,
          mp.name AS midfielder_name,
          ap.name AS attacker_name
        FROM team_of_week tw
        LEFT JOIN players gp
          ON gp.id = tw.goalkeeper_id
        LEFT JOIN players dp
          ON dp.id = tw.defender_id
        LEFT JOIN players mp
          ON mp.id = tw.midfielder_id
        LEFT JOIN players ap
          ON ap.id = tw.attacker_id
        ORDER BY
          tw.created_at DESC,
          tw.id DESC
      `)
    ]);

    res.json({
      ok: true,
      teams: teams.rows,
      players: players.rows,
      matches: matches.rows,
      events: events.rows,
      notifications: notifications.rows,
      transfers: transfers.rows,
      teamOfWeek: teamOfWeek.rows,
      push: {
        enabled: pushEnabled,
        publicKey: VAPID_PUBLIC_KEY || ""
      }
    });
  } catch (err) {
    console.error("State error:", err);

    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/* =========================================================
   ADMIN AUTH — FIXED
========================================================= */

function signAdminToken() {
  return jwt.sign(
    {
      role: "admin",
      admin: true
    },
    JWT_SECRET,
    {
      expiresIn: "7d"
    }
  );
}

function getAdminToken(req) {
  // 1. Cookie
  if (
    req.cookies &&
    req.cookies.aliscore_admin
  ) {
    return req.cookies.aliscore_admin;
  }

  // 2. Authorization Bearer
  const auth =
    req.headers.authorization || "";

  if (
    auth &&
    auth.startsWith("Bearer ")
  ) {
    return auth
      .slice(7)
      .trim();
  }

  return null;
}

function verifyAdminToken(token) {
  if (!token) {
    return null;
  }

  try {
    const decoded =
      jwt.verify(
        token,
        JWT_SECRET
      );

    if (
      !decoded ||
      decoded.role !== "admin"
    ) {
      return null;
    }

    return decoded;
  } catch (err) {
    return null;
  }
}


const ADMIN_META_TABLES = new Set(["admin_audit_log", "admin_undo_snapshots"]);
function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}
async function getSnapshotTableNames(db = query) {
  const result = await db(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  return result.rows.map(r => r.table_name).filter(n => !ADMIN_META_TABLES.has(n));
}
async function captureAdminSnapshot() {
  const names = await getSnapshotTableNames();
  const snapshot = {};
  for (const name of names) {
    const result = await query(`SELECT * FROM ${quoteIdent(name)}`);
    snapshot[name] = result.rows;
  }
  await query(`
    INSERT INTO admin_undo_snapshots(id, snapshot, created_at)
    VALUES (1, $1::jsonb, NOW())
    ON CONFLICT (id) DO UPDATE SET snapshot=EXCLUDED.snapshot, created_at=EXCLUDED.created_at
  `, [JSON.stringify(snapshot)]);
}
async function writeAdminLog(action, method, route, statusCode) {
  try {
    await query("INSERT INTO admin_audit_log(action,method,path,status_code) VALUES ($1,$2,$3,$4)",
      [action, method, route, statusCode]);
  } catch (err) { console.error("ADMIN AUDIT LOG ERROR:", err.message); }
}
async function orderTablesForRestore(client, names) {
  const result = await client.query(`
    SELECT tc.table_name AS child, ccu.table_name AS parent
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.constraint_schema = ccu.constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public' AND ccu.table_schema = 'public'
  `);
  const included = new Set(names);
  const parents = new Map(names.map(n => [n, new Set()]));
  const children = new Map(names.map(n => [n, new Set()]));
  for (const row of result.rows) {
    if (!included.has(row.child) || !included.has(row.parent) || row.child === row.parent) continue;
    parents.get(row.child).add(row.parent);
    children.get(row.parent).add(row.child);
  }
  const ready = names.filter(n => parents.get(n).size === 0);
  const ordered = [];
  while (ready.length) {
    const name = ready.shift(); ordered.push(name);
    for (const child of children.get(name)) {
      parents.get(child).delete(name);
      if (parents.get(child).size === 0 && !ordered.includes(child) && !ready.includes(child)) ready.push(child);
    }
  }
  for (const name of names) if (!ordered.includes(name)) ordered.push(name);
  return ordered;
}

async function requireAdmin(req, res, next) {
  const token = getAdminToken(req);
  const decoded = verifyAdminToken(token);
  if (!decoded) {
    return res.status(401).json({ ok: false, error: "Admin Login required", code: "ADMIN_REQUIRED" });
  }
  req.admin = decoded;
  req.adminToken = token;
  const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
  const skipSnapshot = req.path === "/api/admin-center/undo" || req.path === "/api/admin-center/backup";
  if (mutating && !skipSnapshot) {
    try { await captureAdminSnapshot(); }
    catch (err) { console.error("ADMIN SNAPSHOT ERROR:", err.message); }
    res.on("finish", () => {
      writeAdminLog(`${req.method} ${req.path}`, req.method, req.path, res.statusCode);
    });
  }
  next();
}

/* =========================================================
   ADMIN LOGIN
========================================================= */

app.post(
  "/api/admin/login",
  async (req, res) => {
    try {
      const password =
        req.body &&
        req.body.password !== undefined
          ? String(
              req.body.password
            )
          : "";

      const correctPassword =
        String(
          ADMIN_PASSWORD
        );

      if (
        password !==
        correctPassword
      ) {
        return res.status(401).json({
          ok: false,
          error: "Yanlış şifrə"
        });
      }

      const token =
        signAdminToken();

      /*
        Cookie üçün Render / HTTPS
        uyğun konfiqurasiya.
      */
      res.cookie(
        "aliscore_admin",
        token,
        {
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          path: "/",
          maxAge:
            7 *
            24 *
            60 *
            60 *
            1000
        }
      );

      console.log(
        "ADMIN LOGIN: success"
      );

      res.json({
        ok: true,
        admin: true,
        token
      });
    } catch (err) {
      console.error(
        "ADMIN LOGIN ERROR:",
        err
      );

      res.status(500).json({
        ok: false,
        error:
          "Admin login error"
      });
    }
  }
);

/* =========================================================
   ADMIN ME
========================================================= */

app.get(
  "/api/admin/me",
  (req, res) => {
    const token =
      getAdminToken(req);

    const decoded =
      verifyAdminToken(token);

    if (!decoded) {
      return res.json({
        ok: true,
        admin: false
      });
    }

    res.json({
      ok: true,
      admin: true,
      role: "admin"
    });
  }
);

/* =========================================================
   ADMIN LOGOUT
========================================================= */

app.post(
  "/api/admin/logout",
  (req, res) => {
    res.clearCookie(
      "aliscore_admin",
      {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/"
      }
    );

    res.json({
      ok: true
    });
  }
);

/* =========================================================
   USER ACCOUNTS
========================================================= */

function signUserToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role || "user"
    },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
}

function getUserToken(req) {
  if (req.cookies && req.cookies.aliscore_user) {
    return req.cookies.aliscore_user;
  }
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return null;
}

function verifyUserToken(token) {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded || !decoded.id) return null;
    return decoded;
  } catch {
    return null;
  }
}

function requireUser(req, res, next) {
  const user = verifyUserToken(getUserToken(req));
  if (!user) {
    return res.status(401).json({ ok: false, error: "Hesaba daxil olmaq lazımdır", code: "LOGIN_REQUIRED" });
  }
  req.user = user;
  next();
}

app.post("/api/auth/register", async (req, res) => {
  try {
    const username = cleanString(req.body?.username);
    const email = cleanString(req.body?.email).toLowerCase();
    const password = String(req.body?.password || "");

    if (!username || !email || !password) {
      return res.status(400).json({ ok: false, error: "İstifadəçi adı, email və şifrə tələb olunur" });
    }
    if (username.length < 3) {
      return res.status(400).json({ ok: false, error: "İstifadəçi adı ən azı 3 simvol olmalıdır" });
    }
    if (password.length < 6) {
      return res.status(400).json({ ok: false, error: "Şifrə ən azı 6 simvol olmalıdır" });
    }
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ ok: false, error: "Email düzgün deyil" });
    }

    const exists = await query(
      `SELECT id FROM users WHERE LOWER(email)=LOWER($1) OR LOWER(username)=LOWER($2) LIMIT 1`,
      [email, username]
    );
    if (exists.rows.length) {
      return res.status(409).json({ ok: false, error: "Bu email və ya istifadəçi adı artıq qeydiyyatdan keçib" });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const result = await query(
      `INSERT INTO users (username,email,password_hash) VALUES ($1,$2,$3) RETURNING id,username,email,role,created_at`,
      [username, email, passwordHash]
    );
    const user = result.rows[0];
    const token = signUserToken(user);

    res.cookie("aliscore_user", token, {
      httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 30*24*60*60*1000
    });
    res.status(201).json({ ok: true, user });
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = cleanString(req.body?.email).toLowerCase();
    const password = String(req.body?.password || "");
    const result = await query(`SELECT id,username,email,password_hash,role,created_at FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`, [email]);
    const row = result.rows[0];
    if (!row || !(await bcrypt.compare(password, row.password_hash))) {
      return res.status(401).json({ ok: false, error: "Email və ya şifrə yanlışdır" });
    }
    const user = { id: row.id, username: row.username, email: row.email, role: row.role, created_at: row.created_at };
    const token = signUserToken(user);
    res.cookie("aliscore_user", token, {
      httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 30*24*60*60*1000
    });
    res.json({ ok: true, user });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ ok: false, error: "Giriş xətası" });
  }
});

app.get("/api/auth/me", (req, res) => {
  const user = verifyUserToken(getUserToken(req));
  if (!user) return res.json({ ok: true, loggedIn: false, user: null });
  res.json({ ok: true, loggedIn: true, user });
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("aliscore_user", { httpOnly: true, secure: true, sameSite: "lax", path: "/" });
  res.json({ ok: true });
});

/* =========================================================
   ALISCORE CHAMPIONS LEAGUE — separate from regular matches
========================================================= */

async function getChampionsLeagueData() {
  const teamsResult = await query(`SELECT id, name, logo FROM teams ORDER BY name ASC`);
  const fixturesResult = await query(`
    SELECT m.*, ht.name AS home_team_name, ht.logo AS home_team_logo,
           at.name AS away_team_name, at.logo AS away_team_logo
    FROM champions_league_matches m
    JOIN teams ht ON ht.id = m.home_team_id
    JOIN teams at ON at.id = m.away_team_id
    ORDER BY m.leg ASC, m.round_no ASC, m.id ASC
  `);
  const allTeams = teamsResult.rows;
  const fixtures = fixturesResult.rows;
  const table = new Map(allTeams.map(t => [String(t.id), {
    team_id: t.id, team_name: t.name, logo: t.logo || '',
    played: 0, wins: 0, draws: 0, losses: 0,
    goals_for: 0, goals_against: 0, goal_difference: 0, points: 0
  }]));
  for (const m of fixtures) {
    if (m.status !== 'finished' || m.home_score === null || m.away_score === null) continue;
    const home = table.get(String(m.home_team_id));
    const away = table.get(String(m.away_team_id));
    if (!home || !away) continue;
    const hs = Number(m.home_score), as = Number(m.away_score);
    home.played++; away.played++;
    home.goals_for += hs; home.goals_against += as;
    away.goals_for += as; away.goals_against += hs;
    if (hs > as) { home.wins++; home.points += 3; away.losses++; }
    else if (hs < as) { away.wins++; away.points += 3; home.losses++; }
    else { home.draws++; away.draws++; home.points++; away.points++; }
  }
  const standings = [...table.values()].map(t => ({...t, goal_difference:t.goals_for-t.goals_against}))
    .sort((a,b) => b.points-a.points || b.goal_difference-a.goal_difference || b.goals_for-a.goals_for || a.team_name.localeCompare(b.team_name));
  const allGroupMatchesFinished = fixtures.length === 20 && fixtures.every(m => m.status === 'finished');
  const qualified = allGroupMatchesFinished ? standings.slice(0,2) : [];
  let final = null;
  if (qualified.length === 2) {
    const oldFinal = await query(`SELECT * FROM champions_league_final WHERE id=1`);
    const old = oldFinal.rows[0];
    if (!old || Number(old.home_team_id) !== Number(qualified[0].team_id) || Number(old.away_team_id) !== Number(qualified[1].team_id)) {
      await query(`
        UPDATE champions_league_final
        SET home_team_id=$1, away_team_id=$2, home_score=NULL, away_score=NULL, status='scheduled', updated_at=NOW()
        WHERE id=1
      `,[qualified[0].team_id,qualified[1].team_id]);
    }
    const fr = await query(`
      SELECT f.*, ht.name AS home_team_name, at.name AS away_team_name
      FROM champions_league_final f
      LEFT JOIN teams ht ON ht.id=f.home_team_id
      LEFT JOIN teams at ON at.id=f.away_team_id WHERE f.id=1
    `);
    final = fr.rows[0] || null;
  } else {
    const fr = await query(`
      SELECT f.*, ht.name AS home_team_name, at.name AS away_team_name
      FROM champions_league_final f
      LEFT JOIN teams ht ON ht.id=f.home_team_id
      LEFT JOIN teams at ON at.id=f.away_team_id WHERE f.id=1
    `);
    final = fr.rows[0] || null;
  }
  const champion = final && final.status === 'finished' && final.home_score !== null && final.away_score !== null && Number(final.home_score) !== Number(final.away_score)
    ? {team_name:Number(final.home_score)>Number(final.away_score)?final.home_team_name:final.away_team_name}
    : null;
  const firstRound=fixtures.filter(m=>Number(m.leg)===1).slice(0,2);
  return { teams:allTeams, fixtures, standings, qualified, final, champion, firstRound, generated:fixtures.length===20, allGroupMatchesFinished };
}

app.get("/api/champions-league", async (req, res) => {
  try { res.json(await getChampionsLeagueData()); }
  catch (err) { console.error("Champions League load error:",err); res.status(500).json({error:"Çempionlar Liqası yüklənmədi."}); }
});

app.post("/api/champions-league/generate", requireAdmin, async (req, res) => {
  try {
    const existing = await query(`SELECT COUNT(*)::int AS count FROM champions_league_matches`);
    if (Number(existing.rows[0].count) > 0) return res.status(409).json({error:"Oyun cədvəli artıq yaradılıb."});
    const tr = await query(`SELECT id, name FROM teams ORDER BY id ASC`);
    if (tr.rows.length !== 5) return res.status(400).json({error:`Liqa üçün dəqiq 5 komanda lazımdır. Hazırda ${tr.rows.length} komanda var.`});
    const validIds = tr.rows.map(t=>Number(t.id));
    let ids = Array.isArray(req.body?.team_order) ? req.body.team_order.map(Number) : [];
    if (ids.length !== 5 || new Set(ids).size !== 5 || ids.some(id=>!validIds.includes(id))) {
      return res.status(400).json({error:"Əvvəlcə 5 komandanın püşkünü tamamla."});
    }
    // Circle-method round robin. Arrange the initial wheel so the drawn order
    // yields match 1 (drawn teams 1-2), match 2 (teams 3-4), and a bye (team 5).
    const wheel = [ids[0], ids[2], ids[4], null, ids[3], ids[1]];
    const rounds = [];
    for (let round=1; round<=5; round++) {
      const pairs=[];
      for (let i=0;i<3;i++) {
        const a=wheel[i], b=wheel[5-i];
        if (a!==null && b!==null) pairs.push([a,b]);
      }
      rounds.push(pairs);
      const last=wheel.pop(); wheel.splice(1,0,last);
    }
    // Insert first-leg fixtures in round order, then the return fixtures.
    for (let r=0;r<rounds.length;r++) {
      for (const [home,away] of rounds[r]) {
        await query(`INSERT INTO champions_league_matches(home_team_id,away_team_id,leg,round_no) VALUES($1,$2,1,$3)`,[home,away,r+1]);
      }
    }
    for (let r=0;r<rounds.length;r++) {
      for (const [home,away] of rounds[r]) {
        await query(`INSERT INTO champions_league_matches(home_team_id,away_team_id,leg,round_no) VALUES($1,$2,2,$3)`,[away,home,r+1]);
      }
    }
    res.json({ok:true,created:20,firstRound:rounds[0]});
  } catch(err) { console.error("Champions League generate error:",err); res.status(500).json({error:"Oyun cədvəlini yaratmaq olmadı."}); }
});

app.put("/api/champions-league/matches/:id", requireAdmin, async (req, res) => {
  try {
    const id=Number(req.params.id), hs=Number(req.body.home_score), as=Number(req.body.away_score);
    if (!Number.isInteger(id) || !Number.isInteger(hs) || !Number.isInteger(as) || hs<0 || as<0 || hs>99 || as>99) return res.status(400).json({error:"Hesab 0–99 aralığında tam ədəd olmalıdır."});
    const result=await query(`UPDATE champions_league_matches SET home_score=$1,away_score=$2,status='finished' WHERE id=$3 RETURNING id`,[hs,as,id]);
    if (!result.rowCount) return res.status(404).json({error:"Matç tapılmadı."});
    res.json({ok:true});
  } catch(err) { console.error("Champions League score error:",err); res.status(500).json({error:"Matç nəticəsini saxlamaq olmadı."}); }
});


/* =========================================================
   CHAMPIONS LEAGUE — SEPARATE PLAYER STATISTICS + 8-PLAYER XI
========================================================= */
app.get("/api/champions-league/statistics", async (req, res) => {
  try {
    const result = await query(`
      SELECT p.id AS player_id, p.name AS player_name, p.position, p.photo,
             t.name AS team_name,
             COALESCE(s.goals,0)::int AS goals, COALESCE(s.assists,0)::int AS assists,
             COALESCE(s.saves,0)::int AS saves, COALESCE(s.own_goals,0)::int AS own_goals,
             COALESCE(s.yellow_cards,0)::int AS yellow_cards, COALESCE(s.red_cards,0)::int AS red_cards,
             COALESCE(s.appearances,0)::int AS appearances,
             (COALESCE(s.goals,0)*3 + COALESCE(s.assists,0)*2 + COALESCE(s.saves,0)
              - COALESCE(s.own_goals,0)*3 - COALESCE(s.yellow_cards,0)*2 - COALESCE(s.red_cards,0)*4) AS rating
      FROM players p LEFT JOIN teams t ON t.id=p.team_id
      LEFT JOIN champions_league_player_stats s ON s.player_id=p.id
      ORDER BY rating DESC, goals DESC, assists DESC, p.name ASC
    `);
    // The weekly team stays hidden until all matches in the latest played round are finished.
    const roundsResult = await query(`SELECT round_no, status FROM champions_league_matches ORDER BY round_no ASC, id ASC`);
    const playedRounds = roundsResult.rows.filter(m => m.status === 'finished').map(m => Number(m.round_no));
    const latestPlayedRound = playedRounds.length ? Math.max(...playedRounds) : null;
    const latestRoundMatches = latestPlayedRound === null ? [] : roundsResult.rows.filter(m => Number(m.round_no) === latestPlayedRound);
    const weekReady = latestRoundMatches.length > 0 && latestRoundMatches.every(m => m.status === 'finished');

    // Automatically select the Champions League Team of the Week from tournament stats.
    // Eligible players must have played or recorded at least one tournament statistic.
    const eligible = result.rows.filter(p =>
      Number(p.appearances || 0) > 0 || Number(p.goals || 0) > 0 || Number(p.assists || 0) > 0 ||
      Number(p.saves || 0) > 0 || Number(p.own_goals || 0) > 0 || Number(p.yellow_cards || 0) > 0 || Number(p.red_cards || 0) > 0
    );
    const byPerformance = (a, b) => Number(b.rating || 0) - Number(a.rating || 0) ||
      Number(b.goals || 0) - Number(a.goals || 0) || Number(b.assists || 0) - Number(a.assists || 0) ||
      Number(b.saves || 0) - Number(a.saves || 0) || Number(b.appearances || 0) - Number(a.appearances || 0) ||
      String(a.player_name || '').localeCompare(String(b.player_name || ''));
    eligible.sort(byPerformance);
    const isGoalkeeper = p => /qap[iı]çı|goal.?keeper|keeper|\bgk\b|gözətçi/i.test(String(p.position || ''));
    const goalkeeper = eligible.filter(isGoalkeeper).sort(byPerformance)[0];
    let selected = eligible.filter(p => !goalkeeper || Number(p.player_id) !== Number(goalkeeper.player_id)).slice(0, goalkeeper ? 7 : 8);
    if (goalkeeper) selected.unshift(goalkeeper);
    const teamOfWeek = weekReady && selected.length === 8 ? {
      id: null,
      week: String(latestPlayedRound),
      player_ids: selected.map(p => Number(p.player_id)),
      automatic: true,
      players: selected
    } : null;
    res.json({ players: result.rows, teamOfWeek, weekReady, latestPlayedRound });
  } catch (err) { console.error("Champions League statistics error:", err); res.status(500).json({ error: "Çempionlar Liqası statistikası yüklənmədi." }); }
});

app.put("/api/champions-league/statistics/:playerId", requireAdmin, async (req, res) => {
  try {
    const playerId = Number(req.params.playerId);
    const fields = ["goals","assists","saves","own_goals","yellow_cards","red_cards","appearances"];
    if (!Number.isInteger(playerId) || playerId < 1) return res.status(400).json({ error: "Oyunçu düzgün seçilməyib." });
    const vals = fields.map(k => req.body?.[k] === undefined ? 0 : Number(req.body[k]));
    if (vals.some(v => !Number.isInteger(v) || v < 0 || v > 9999)) return res.status(400).json({ error: "Statistika 0–9999 aralığında tam ədəd olmalıdır." });
    const exists = await query(`SELECT id FROM players WHERE id=$1`, [playerId]);
    if (!exists.rowCount) return res.status(404).json({ error: "Oyunçu tapılmadı." });
    await query(`INSERT INTO champions_league_player_stats(player_id,goals,assists,saves,own_goals,yellow_cards,red_cards,appearances,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW()) ON CONFLICT(player_id) DO UPDATE SET
      goals=EXCLUDED.goals, assists=EXCLUDED.assists, saves=EXCLUDED.saves, own_goals=EXCLUDED.own_goals,
      yellow_cards=EXCLUDED.yellow_cards, red_cards=EXCLUDED.red_cards, appearances=EXCLUDED.appearances, updated_at=NOW()`, [playerId,...vals]);
    res.json({ ok: true });
  } catch (err) { console.error("Champions League stat update error:", err); res.status(500).json({ error: "Statistikanı saxlamaq olmadı." }); }
});

app.post("/api/champions-league/team-of-week", requireAdmin, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.player_ids) ? [...new Set(req.body.player_ids.map(Number))] : [];
    if (ids.length !== 8 || ids.some(id => !Number.isInteger(id) || id < 1)) return res.status(400).json({ error: "Həftənin komandası üçün dəqiq 8 fərqli oyunçu seç." });
    const found = await query(`SELECT id FROM players WHERE id = ANY($1::int[])`, [ids]);
    if (found.rowCount !== 8) return res.status(400).json({ error: "Seçilmiş oyunçulardan biri tapılmadı." });
    const week = String(req.body?.week || new Date().toISOString().slice(0,10)).slice(0,10);
    const saved = await query(`INSERT INTO champions_league_team_of_week(week,player_ids) VALUES($1,$2::jsonb) RETURNING id,week,player_ids,created_at`, [week, JSON.stringify(ids)]);
    res.json({ ok: true, teamOfWeek: saved.rows[0] });
  } catch (err) { console.error("Champions League team of week save error:", err); res.status(500).json({ error: "Həftənin komandasını saxlamaq olmadı." }); }
});

app.put("/api/champions-league/final", requireAdmin, async (req, res) => {
  try {
    const hs=Number(req.body.home_score), as=Number(req.body.away_score);
    if (!Number.isInteger(hs) || !Number.isInteger(as) || hs<0 || as<0 || hs>99 || as>99) return res.status(400).json({error:"Hesab 0–99 aralığında tam ədəd olmalıdır."});
    const data=await getChampionsLeagueData();
    if (!data.qualified || data.qualified.length!==2) return res.status(400).json({error:"Final üçün əvvəlcə bütün 20 qrup matçı tamamlanmalıdır."});
    if (hs===as) return res.status(400).json({error:"Finalda bərabər hesab üçün penalti qalibi seçilməlidir. Hazırda hesab bərabər ola bilməz."});
    await query(`UPDATE champions_league_final SET home_score=$1,away_score=$2,status='finished',updated_at=NOW() WHERE id=1`,[hs,as]);
    res.json({ok:true});
  } catch(err) { console.error("Champions League final error:",err); res.status(500).json({error:"Final nəticəsini saxlamaq olmadı."}); }
});

/* =========================================================
   TEAMS
========================================================= */

app.get("/api/teams", async (req, res) => {
  try {
    const result = await query(`
      SELECT
        t.*,
        (
          t.goals_for -
          t.goals_against
        ) AS goal_difference
      FROM teams t
      ORDER BY
        t.points DESC,
        (
          t.goals_for -
          t.goals_against
        ) DESC,
        t.goals_for DESC,
        t.name ASC
    `);

    res.json({
      ok: true,
      teams: result.rows
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.post(
  "/api/teams",
  requireAdmin,
  async (req, res) => {
    try {
      const name =
        cleanString(req.body.name);

      const logo =
        cleanString(req.body.logo);

      if (!name) {
        return res.status(400).json({
          ok: false,
          error:
            "Komanda adı tələb olunur"
        });
      }

      const result = await query(
        `
          INSERT INTO teams
            (name, logo, captain)
          VALUES
            ($1, $2, $3)
          RETURNING *
        `,
        [name, logo, cleanString(req.body.captain)]
      );

      res.json({
        ok: true,
        team: result.rows[0]
      });
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err.message
      });
    }
  }
);

async function updateTeam(req, res) {
  try {
    const id =
      intValue(req.params.id);

    const current =
      await query(
        `
          SELECT *
          FROM teams
          WHERE id = $1
        `,
        [id]
      );

    if (!current.rows.length) {
      return res.status(404).json({
        ok: false,
        error:
          "Komanda tapılmadı"
      });
    }

    const old =
      current.rows[0];

    const name =
      req.body.name !== undefined
        ? cleanString(req.body.name)
        : old.name;

    const logo =
      req.body.logo !== undefined
        ? cleanString(req.body.logo)
        : old.logo;

    const captain =
      req.body.captain !== undefined
        ? cleanString(req.body.captain)
        : old.captain || "";

    const points =
      req.body.points !== undefined
        ? intValue(req.body.points)
        : old.points;

    const played =
      req.body.played !== undefined
        ? intValue(req.body.played)
        : old.played;

    const wins =
      req.body.wins !== undefined
        ? intValue(req.body.wins)
        : old.wins;

    const draws =
      req.body.draws !== undefined
        ? intValue(req.body.draws)
        : old.draws;

    const losses =
      req.body.losses !== undefined
        ? intValue(req.body.losses)
        : old.losses;

    const goalsFor =
      req.body.goals_for !== undefined
        ? intValue(req.body.goals_for)
        : old.goals_for;

    const goalsAgainst =
      req.body.goals_against !== undefined
        ? intValue(req.body.goals_against)
        : old.goals_against;

    const result =
      await query(
        `
          UPDATE teams
          SET
            name = $1,
            logo = $2,
            captain = $3,
            points = $4,
            played = $5,
            wins = $6,
            draws = $7,
            losses = $8,
            goals_for = $9,
            goals_against = $10
          WHERE id = $11
          RETURNING *
        `,
        [
          name,
          logo,
          captain,
          points,
          played,
          wins,
          draws,
          losses,
          goalsFor,
          goalsAgainst,
          id
        ]
      );

    res.json({
      ok: true,
      team: result.rows[0]
    });
  } catch (err) {
    res.status(400).json({
      ok: false,
      error: err.message
    });
  }
}

app.put(
  "/api/teams/:id",
  requireAdmin,
  updateTeam
);

app.patch(
  "/api/teams/:id",
  requireAdmin,
  updateTeam
);

app.delete(
  "/api/teams/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        intValue(req.params.id);

      await query(
        `
          DELETE FROM teams
          WHERE id = $1
        `,
        [id]
      );

      res.json({
        ok: true
      });
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err.message
      });
    }
  }
);

/* =========================================================
   PLAYERS
========================================================= */

app.get(
  "/api/players",
  async (req, res) => {
    try {
      const result =
        await query(`
          SELECT
            p.*,
            COALESCE((SELECT COUNT(*) FROM matches mm WHERE mm.player_of_match_id = p.id), 0)::INTEGER AS mvp_count,
            t.name AS team_name,
            t.logo AS team_logo
          FROM players p
          LEFT JOIN teams t
            ON t.id = p.team_id
          ORDER BY
            t.name ASC,
            p.number ASC,
            p.name ASC
        `);

      res.json({
        ok: true,
        players: result.rows
      });
    } catch (err) {
      console.error(
        "GET PLAYERS ERROR:",
        err
      );

      res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }
);

app.post(
  "/api/players",
  requireAdmin,
  async (req, res) => {
    try {
      const teamId =
        nullableInt(
          req.body.team_id !== undefined
            ? req.body.team_id
            : req.body.teamId
        );

      const name =
        cleanString(
          req.body.name
        );

      const number =
        intValue(
          req.body.number !== undefined
            ? req.body.number
            : req.body.player_number
        );

      const rawPosition =
        req.body.position !== undefined
          ? req.body.position
          : req.body.player_position !== undefined
            ? req.body.player_position
            : req.body.role;

      const position =
        cleanString(rawPosition);

      const photo =
        cleanString(
          req.body.photo
        );

      const rating =
        req.body.rating !== undefined && req.body.rating !== ""
          ? numberValue(req.body.rating, 0)
          : 0;

      const transferValue =
        Math.max(
          0,
          numberValue(
            req.body.transfer_value !== undefined
              ? req.body.transfer_value
              : req.body.transferValue,
            0
          )
        );

      if (!Number.isFinite(rating)) {
        return res.status(400).json({
          ok: false,
          error: "Rating düzgün deyil"
        });
      }

      if (!name) {
        return res.status(400).json({
          ok: false,
          error:
            "Oyunçu adı tələb olunur"
        });
      }

      if (teamId !== null) {
        const team =
          await query(
            `
              SELECT id
              FROM teams
              WHERE id = $1
            `,
            [teamId]
          );

        if (!team.rows.length) {
          return res.status(400).json({
            ok: false,
            error:
              "Komanda tapılmadı"
          });
        }
      }

      const result =
        await query(
          `
            INSERT INTO players
              (
                team_id,
                name,
                number,
                position,
                photo,
                rating,
                transfer_value
              )
            VALUES
              ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
          `,
          [
            teamId,
            name,
            number,
            position,
            photo,
            rating,
            transferValue
          ]
        );

      res.status(201).json({
        ok: true,
        player:
          result.rows[0]
      });
    } catch (err) {
      console.error(
        "ADD PLAYER ERROR:",
        err
      );

      res.status(400).json({
        ok: false,
        error:
          err.message ||
          "Oyunçu əlavə edilmədi"
      });
    }
  }
);

/* =========================================================
   UPDATE PLAYER
========================================================= */

async function updatePlayer(
  req,
  res
) {
  try {
    const id =
      intValue(req.params.id);

    if (!id) {
      return res.status(400).json({
        ok: false,
        error:
          "Yanlış oyunçu ID-si"
      });
    }

    const current =
      await query(
        `
          SELECT *
          FROM players
          WHERE id = $1
        `,
        [id]
      );

    if (!current.rows.length) {
      return res.status(404).json({
        ok: false,
        error:
          "Oyunçu tapılmadı"
      });
    }

    const old =
      current.rows[0];

    const teamId =
      req.body.team_id !== undefined
        ? nullableInt(req.body.team_id)
        : req.body.teamId !== undefined
          ? nullableInt(req.body.teamId)
          : old.team_id;

    const name =
      req.body.name !== undefined
        ? cleanString(req.body.name)
        : old.name;

    const number =
      req.body.number !== undefined
        ? intValue(req.body.number)
        : req.body.player_number !== undefined
          ? intValue(req.body.player_number)
          : old.number;

    const rawPosition =
      req.body.position !== undefined
        ? req.body.position
        : req.body.player_position !== undefined
          ? req.body.player_position
          : req.body.role;

    const position =
      rawPosition !== undefined
        ? cleanString(rawPosition)
        : old.position;

    const photo =
      req.body.photo !== undefined
        ? cleanString(req.body.photo)
        : old.photo;

    const goals =
      req.body.goals !== undefined
        ? intValue(req.body.goals)
        : old.goals;

    const assists =
      req.body.assists !== undefined
        ? intValue(req.body.assists)
        : old.assists;

    const saves =
      req.body.saves !== undefined
        ? intValue(req.body.saves)
        : old.saves;

    const yellowCards =
      req.body.yellow_cards !== undefined
        ? intValue(req.body.yellow_cards)
        : old.yellow_cards;

    const redCards =
      req.body.red_cards !== undefined
        ? intValue(req.body.red_cards)
        : old.red_cards;

    const ownGoals =
      req.body.own_goals !== undefined
        ? intValue(req.body.own_goals)
        : old.own_goals;

    const transferValue =
      req.body.transfer_value !== undefined
        ? Math.max(0, numberValue(req.body.transfer_value, 0))
        : old.transfer_value;

    let rating =
      old.rating !== null &&
      old.rating !== undefined
        ? Number(old.rating)
        : 0;

    if (
      req.body.rating !==
      undefined
    ) {
      const parsedRating =
        Number(req.body.rating);

      if (
        !Number.isFinite(
          parsedRating
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Rating düzgün deyil"
        });
      }

      rating = parsedRating;
    }

    if (!Number.isFinite(rating)) {
      rating = 0;
    }

    if (teamId !== null) {
      const team =
        await query(
          `
            SELECT id
            FROM teams
            WHERE id = $1
          `,
          [teamId]
        );

      if (!team.rows.length) {
        return res.status(400).json({
          ok: false,
          error:
            "Komanda tapılmadı"
        });
      }
    }

    const result =
      await query(
        `
          UPDATE players
          SET
            team_id = $1,
            name = $2,
            number = $3,
            position = $4,
            photo = $5,
            goals = $6,
            assists = $7,
            saves = $8,
            yellow_cards = $9,
            red_cards = $10,
            own_goals = $11,
            transfer_value = $12,
            rating = $13
          WHERE id = $14
          RETURNING *
        `,
        [
          teamId,
          name,
          number,
          position,
          photo,
          goals,
          assists,
          saves,
          yellowCards,
          redCards,
          ownGoals,
          transferValue,
          rating,
          id
        ]
      );

    res.json({
      ok: true,
      player:
        result.rows[0]
    });
  } catch (err) {
    console.error(
      "UPDATE PLAYER ERROR:",
      err
    );

    res.status(400).json({
      ok: false,
      error:
        err.message ||
        "Oyunçu yadda saxlanmadı"
    });
  }
}

app.put(
  "/api/players/:id",
  requireAdmin,
  updatePlayer
);

app.patch(
  "/api/players/:id",
  requireAdmin,
  updatePlayer
);

app.delete(
  "/api/players/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        intValue(req.params.id);

      if (!id) {
        return res.status(400).json({
          ok: false,
          error:
            "Yanlış oyunçu ID-si"
        });
      }

      await query(
        `
          DELETE FROM players
          WHERE id = $1
        `,
        [id]
      );

      res.json({
        ok: true
      });
    } catch (err) {
      console.error(
        "DELETE PLAYER ERROR:",
        err
      );

      res.status(400).json({
        ok: false,
        error: err.message
      });
    }
  }
);

/* =========================================================
   MATCHES
========================================================= */

app.get(
  "/api/matches",
  async (req, res) => {
    try {
      const result =
        await query(`
          SELECT
            m.*,
            ht.name AS home_team_name,
            ht.logo AS home_team_logo,
            at.name AS away_team_name,
            at.logo AS away_team_logo
          FROM matches m
          LEFT JOIN teams ht
            ON ht.id = m.home_team_id
          LEFT JOIN teams at
            ON at.id = m.away_team_id
          ORDER BY
            m.match_date DESC,
            m.id DESC
        `);

      res.json({
        ok: true,
        matches:
          result.rows
      });
    } catch (err) {
      console.error(
        "GET MATCHES ERROR:",
        err
      );

      res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }
);

app.post(
  "/api/matches",
  requireAdmin,
  async (req, res) => {
    try {
      const homeTeamId =
        nullableInt(
          req.body.home_team_id !== undefined
            ? req.body.home_team_id
            : req.body.homeTeamId
        );

      const awayTeamId =
        nullableInt(
          req.body.away_team_id !== undefined
            ? req.body.away_team_id
            : req.body.awayTeamId
        );

      const homeScore =
        intValue(
          req.body.home_score !== undefined
            ? req.body.home_score
            : req.body.homeScore
        );

      const awayScore =
        intValue(
          req.body.away_score !== undefined
            ? req.body.away_score
            : req.body.awayScore
        );

      const status =
        cleanString(
          req.body.status
        ) || "scheduled";

      const matchDate =
        req.body.match_date ||
        req.body.matchDate ||
        new Date().toISOString();

      const venue =
        cleanString(
          req.body.venue
        );

      const playerOfMatchId =
        nullableInt(req.body.player_of_match_id);

      if (
        !homeTeamId ||
        !awayTeamId
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "İki komanda seçilməlidir"
        });
      }

      if (
        homeTeamId ===
        awayTeamId
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Eyni komanda ilə matç yaratmaq olmaz"
        });
      }

      const teams =
        await query(
          `
            SELECT id
            FROM teams
            WHERE id = ANY($1)
          `,
          [[
            homeTeamId,
            awayTeamId
          ]]
        );

      if (
        teams.rows.length !== 2
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Seçilmiş komandalar tapılmadı"
        });
      }

      const result =
        await query(
          `
            INSERT INTO matches
              (
                home_team_id,
                away_team_id,
                home_score,
                away_score,
                status,
                match_date,
                venue
              )
            VALUES
              ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
          `,
          [
            homeTeamId,
            awayTeamId,
            homeScore,
            awayScore,
            status,
            matchDate,
            venue
          ]
        );

      res.status(201).json({
        ok: true,
        match:
          result.rows[0]
      });
    } catch (err) {
      console.error(
        "ADD MATCH ERROR:",
        err
      );

      res.status(400).json({
        ok: false,
        error:
          err.message ||
          "Matç əlavə edilmədi"
      });
    }
  }
);

async function updateMatch(
  req,
  res
) {
  try {
    const id =
      intValue(req.params.id);

    const current =
      await query(
        `
          SELECT *
          FROM matches
          WHERE id = $1
        `,
        [id]
      );

    if (!current.rows.length) {
      return res.status(404).json({
        ok: false,
        error:
          "Matç tapılmadı"
      });
    }

    const old =
      current.rows[0];

    const homeTeamId =
      req.body.home_team_id !== undefined
        ? nullableInt(req.body.home_team_id)
        : old.home_team_id;

    const awayTeamId =
      req.body.away_team_id !== undefined
        ? nullableInt(req.body.away_team_id)
        : old.away_team_id;

    const homeScore =
      req.body.home_score !== undefined
        ? intValue(req.body.home_score)
        : old.home_score;

    const awayScore =
      req.body.away_score !== undefined
        ? intValue(req.body.away_score)
        : old.away_score;

    const status =
      req.body.status !== undefined
        ? cleanString(req.body.status)
        : old.status;

    const matchDate =
      req.body.match_date !== undefined
        ? req.body.match_date
        : old.match_date;

    const venue =
      req.body.venue !== undefined
        ? cleanString(req.body.venue)
        : old.venue;

    const playerOfMatchId =
      req.body.player_of_match_id !== undefined
        ? nullableInt(req.body.player_of_match_id)
        : old.player_of_match_id;

    if (playerOfMatchId !== null) {
      const pom = await query(
        `SELECT id, team_id FROM players WHERE id = $1`,
        [playerOfMatchId]
      );
      if (!pom.rows.length) {
        return res.status(400).json({
          ok: false,
          error: "Oyunçu matçı tapılmadı"
        });
      }
      const pomTeam = Number(pom.rows[0].team_id);
      if (pomTeam !== Number(homeTeamId) && pomTeam !== Number(awayTeamId)) {
        return res.status(400).json({
          ok: false,
          error: "Oyunçu bu matçdakı komandalardan birinə aid olmalıdır"
        });
      }
    }

    if (
      homeTeamId &&
      awayTeamId &&
      homeTeamId === awayTeamId
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Eyni komanda ilə matç yaratmaq olmaz"
      });
    }

    if (Number(old.player_of_match_id || 0) !== Number(playerOfMatchId || 0)) {
      if (old.player_of_match_id) {
        await query(
          `UPDATE players SET mvp_count = GREATEST(COALESCE(mvp_count,0)-1,0) WHERE id=$1`,
          [old.player_of_match_id]
        );
      }
      if (playerOfMatchId) {
        await query(
          `UPDATE players SET mvp_count = COALESCE(mvp_count,0)+1 WHERE id=$1`,
          [playerOfMatchId]
        );
      }
    }

    const result =
      await query(
        `
          UPDATE matches
          SET
            home_team_id = $1,
            away_team_id = $2,
            home_score = $3,
            away_score = $4,
            status = $5,
            match_date = $6,
            venue = $7,
            player_of_match_id = $8
          WHERE id = $9
          RETURNING *
        `,
        [
          homeTeamId,
          awayTeamId,
          homeScore,
          awayScore,
          status,
          matchDate,
          venue,
          playerOfMatchId,
          id
        ]
      );

    res.json({
      ok: true,
      match:
        result.rows[0]
    });
  } catch (err) {
    console.error(
      "UPDATE MATCH ERROR:",
      err
    );

    res.status(400).json({
      ok: false,
      error: err.message
    });
  }
}

app.put(
  "/api/matches/:id",
  requireAdmin,
  updateMatch
);

app.patch(
  "/api/matches/:id",
  requireAdmin,
  updateMatch
);

app.delete(
  "/api/matches/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const id =
        intValue(req.params.id);

      const matchRow = await query(
        `SELECT player_of_match_id FROM matches WHERE id=$1`,
        [id]
      );
      if (matchRow.rows[0]?.player_of_match_id) {
        await query(
          `UPDATE players SET mvp_count=GREATEST(COALESCE(mvp_count,0)-1,0) WHERE id=$1`,
          [matchRow.rows[0].player_of_match_id]
        );
      }

      await query(
        `
          DELETE FROM matches
          WHERE id = $1
        `,
        [id]
      );

      res.json({
        ok: true
      });
    } catch (err) {
      console.error(
        "DELETE MATCH ERROR:",
        err
      );

      res.status(400).json({
        ok: false,
        error: err.message
      });
    }
  }
);

/* =========================================================
   MATCH EVENTS
========================================================= */

app.get(
  "/api/matches/:matchId/events",
  async (req, res) => {
    try {
      const matchId =
        intValue(req.params.matchId);

      const result =
        await query(
          `
            SELECT
              e.*,
              p.name AS player_name,
              p.photo AS player_photo,
              p.number AS player_number,
              p.position AS player_position,
              t.name AS team_name,
              t.logo AS team_logo
            FROM match_events e
            LEFT JOIN players p
              ON p.id = e.player_id
            LEFT JOIN teams t
              ON t.id = e.team_id
            WHERE e.match_id = $1
            ORDER BY
              e.minute ASC,
              e.id ASC
          `,
          [matchId]
        );

      res.json({
        ok: true,
        events:
          result.rows
      });
    } catch (err) {
      console.error(
        "GET EVENTS ERROR:",
        err
      );

      res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }
);

/* =========================================================
   ADD EVENT
========================================================= */

app.post(
  "/api/matches/:matchId/events",
  requireAdmin,
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      const matchId =
        intValue(
          req.params.matchId
        );

      const type =
        cleanString(
          req.body.type
        ).toLowerCase();

      const playerId =
        nullableInt(
          req.body.player_id !== undefined
            ? req.body.player_id
            : req.body.playerId
        );

      let teamId =
        nullableInt(
          req.body.team_id !== undefined
            ? req.body.team_id
            : req.body.teamId
        );

      const minute =
        intValue(
          req.body.minute
        );

      const note =
        cleanString(
          req.body.note
        );

      const allowedTypes = [
        "goal",
        "assist",
        "save",
        "yellow",
        "red",
        "own_goal"
      ];

      if (
        !allowedTypes.includes(type)
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Yanlış hadisə tipi"
        });
      }

      await client.query("BEGIN");

      const matchResult =
        await client.query(
          `
            SELECT *
            FROM matches
            WHERE id = $1
            FOR UPDATE
          `,
          [matchId]
        );

      if (!matchResult.rows.length) {
        throw new Error(
          "Matç tapılmadı"
        );
      }

      const match =
        matchResult.rows[0];

      /*
        Əgər frontend komandanı göndərməyibsə,
        oyunçunun komandasını avtomatik götürürük.
      */
      if (
        !teamId &&
        playerId
      ) {
        const playerResult =
          await client.query(
            `
              SELECT team_id
              FROM players
              WHERE id = $1
            `,
            [playerId]
          );

        if (
          playerResult.rows.length
        ) {
          teamId =
            playerResult.rows[0]
              .team_id;
        }
      }

      if (!teamId) {
        throw new Error(
          "Komanda seçilməlidir"
        );
      }

      if (
        Number(teamId) !==
          Number(
            match.home_team_id
          ) &&
        Number(teamId) !==
          Number(
            match.away_team_id
          )
      ) {
        throw new Error(
          "Bu komanda bu matçda iştirak etmir"
        );
      }

      if (playerId) {
        const playerResult =
          await client.query(
            `
              SELECT *
              FROM players
              WHERE id = $1
            `,
            [playerId]
          );

        if (
          !playerResult.rows.length
        ) {
          throw new Error(
            "Oyunçu tapılmadı"
          );
        }

        const player =
          playerResult.rows[0];

        if (
          Number(player.team_id) !==
          Number(teamId)
        ) {
          throw new Error(
            "Oyunçu seçilən komandaya aid deyil"
          );
        }
      }

      const eventResult =
        await client.query(
          `
            INSERT INTO match_events
              (
                match_id,
                team_id,
                player_id,
                type,
                minute,
                note
              )
            VALUES
              ($1, $2, $3, $4, $5, $6)
            RETURNING *
          `,
          [
            matchId,
            teamId,
            playerId,
            type,
            minute,
            note
          ]
        );

      const event =
        eventResult.rows[0];

      const statColumn =
        eventStatColumn(type);

      if (
        statColumn &&
        playerId
      ) {
        await client.query(
          `
            UPDATE players
            SET ${statColumn} =
              COALESCE(
                ${statColumn},
                0
              ) + 1
            WHERE id = $1
          `,
          [playerId]
        );
      }

      await changePlayerRating(
        client,
        playerId,
        eventRatingDelta(type)
      );

      let updatedMatch =
        match;

      if (type === "goal" || type === "own_goal") {
        const isHome = Number(teamId) === Number(match.home_team_id);
        const homeIncrement = type === "goal" ? (isHome ? 1 : 0) : (isHome ? 0 : 1);
        const awayIncrement = type === "goal" ? (isHome ? 0 : 1) : (isHome ? 1 : 0);

        const scoreResult =
          await client.query(
            `
              UPDATE matches
              SET
                home_score = home_score + $1,
                away_score = away_score + $2
              WHERE id = $3
              RETURNING *
            `,
            [homeIncrement, awayIncrement, matchId]
          );

        updatedMatch = scoreResult.rows[0];
      }

      await client.query("COMMIT");

      let notificationTitle =
        "AliScore";

      let notificationBody =
        "Yeni hadisə";

      if (type === "goal") {
        notificationTitle =
          "⚽ QOL!";

        notificationBody =
          "Matçda yeni qol!";
      }

      if (type === "assist") {
        notificationTitle =
          "🎯 Assist";

        notificationBody =
          "Yeni assist qeydə alındı.";
      }

      if (type === "save") {
        notificationTitle =
          "🧤 Seyv";

        notificationBody =
          "Yeni seyv qeydə alındı.";
      }

      if (type === "yellow") {
        notificationTitle =
          "🟨 Sarı kart";

        notificationBody =
          "Oyunçu sarı kart aldı.";
      }

      if (type === "red") {
        notificationTitle =
          "🟥 Qırmızı kart";

        notificationBody =
          "Oyunçu qırmızı kart aldı.";
      }

      if (type === "own_goal") {
        notificationTitle = "🥅 Avtoqol";
        notificationBody = "Matçda avtoqol qeydə alındı.";
      }

      /*
        Artıq bütün hadisələr üçün
        notification yaradılır.
      */
      await notify(
        type,
        notificationTitle,
        notificationBody,
        {
          matchId,
          eventId: event.id,
          playerId,
          teamId
        }
      );

      const fullEventResult =
        await query(
          `
            SELECT
              e.*,
              p.name AS player_name,
              p.photo AS player_photo,
              p.number AS player_number,
              p.position AS player_position,
              t.name AS team_name,
              t.logo AS team_logo
            FROM match_events e
            LEFT JOIN players p
              ON p.id = e.player_id
            LEFT JOIN teams t
              ON t.id = e.team_id
            WHERE e.id = $1
          `,
          [event.id]
        );

      res.status(201).json({
        ok: true,
        event:
          fullEventResult.rows[0],
        match:
          updatedMatch
      });
    } catch (err) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch (_) {}

      console.error(
        "ADD EVENT ERROR:",
        err
      );

      res.status(400).json({
        ok: false,
        error:
          err.message ||
          "Hadisə əlavə edilmədi"
      });
    } finally {
      client.release();
    }
  }
);

/* =========================================================
   UPDATE EVENT
========================================================= */

app.patch(
  "/api/matches/:matchId/events/:eventId",
  requireAdmin,
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      const matchId =
        intValue(
          req.params.matchId
        );

      const eventId =
        intValue(
          req.params.eventId
        );

      await client.query("BEGIN");

      const matchResult =
        await client.query(
          `
            SELECT *
            FROM matches
            WHERE id = $1
            FOR UPDATE
          `,
          [matchId]
        );

      if (
        !matchResult.rows.length
      ) {
        throw new Error(
          "Matç tapılmadı"
        );
      }

      const match =
        matchResult.rows[0];

      const oldResult =
        await client.query(
          `
            SELECT *
            FROM match_events
            WHERE id = $1
              AND match_id = $2
            FOR UPDATE
          `,
          [
            eventId,
            matchId
          ]
        );

      if (
        !oldResult.rows.length
      ) {
        throw new Error(
          "Hadisə tapılmadı"
        );
      }

      const oldEvent =
        oldResult.rows[0];

      const type =
        req.body.type !== undefined
          ? cleanString(req.body.type).toLowerCase()
          : oldEvent.type;

      const playerId =
        req.body.player_id !== undefined
          ? nullableInt(req.body.player_id)
          : oldEvent.player_id;

      let teamId =
        req.body.team_id !== undefined
          ? nullableInt(req.body.team_id)
          : oldEvent.team_id;

      const minute =
        req.body.minute !== undefined
          ? intValue(req.body.minute)
          : oldEvent.minute;

      const note =
        req.body.note !== undefined
          ? cleanString(req.body.note)
          : oldEvent.note;

      const allowedTypes = [
        "goal",
        "assist",
        "save",
        "yellow",
        "red",
        "own_goal"
      ];

      if (
        !allowedTypes.includes(type)
      ) {
        throw new Error(
          "Yanlış hadisə tipi"
        );
      }

      if (
        !teamId &&
        playerId
      ) {
        const p =
          await client.query(
            `
              SELECT team_id
              FROM players
              WHERE id = $1
            `,
            [playerId]
          );

        if (p.rows.length) {
          teamId =
            p.rows[0].team_id;
        }
      }

      if (!teamId) {
        throw new Error(
          "Komanda seçilməlidir"
        );
      }

      if (
        Number(teamId) !==
          Number(
            match.home_team_id
          ) &&
        Number(teamId) !==
          Number(
            match.away_team_id
          )
      ) {
        throw new Error(
          "Bu komanda bu matçda iştirak etmir"
        );
      }

      if (playerId) {
        const p =
          await client.query(
            `
              SELECT *
              FROM players
              WHERE id = $1
            `,
            [playerId]
          );

        if (!p.rows.length) {
          throw new Error(
            "Oyunçu tapılmadı"
          );
        }

        if (
          Number(
            p.rows[0].team_id
          ) !==
          Number(teamId)
        ) {
          throw new Error(
            "Oyunçu seçilən komandaya aid deyil"
          );
        }
      }

      /* Remove old stat */

      const oldStat =
        eventStatColumn(
          oldEvent.type
        );

      if (
        oldStat &&
        oldEvent.player_id
      ) {
        await client.query(
          `
            UPDATE players
            SET ${oldStat} =
              GREATEST(
                COALESCE(
                  ${oldStat},
                  0
                ) - 1,
                0
              )
            WHERE id = $1
          `,
          [
            oldEvent.player_id
          ]
        );
      }

      await changePlayerRating(
        client,
        oldEvent.player_id,
        -eventRatingDelta(oldEvent.type)
      );

      /* Remove old goal */

      if (
        oldEvent.type === "goal" ||
        oldEvent.type === "own_goal"
      ) {
        const oldIsHome = Number(oldEvent.team_id) === Number(match.home_team_id);
        const oldHome = oldEvent.type === "goal"
          ? (oldIsHome ? 1 : 0)
          : (oldIsHome ? 0 : 1);
        const oldAway = oldEvent.type === "goal"
          ? (oldIsHome ? 0 : 1)
          : (oldIsHome ? 1 : 0);

        await client.query(
          `
            UPDATE matches
            SET
              home_score =
                GREATEST(
                  home_score - $1,
                  0
                ),
              away_score =
                GREATEST(
                  away_score - $2,
                  0
                )
            WHERE id = $3
          `,
          [
            oldHome,
            oldAway,
            matchId
          ]
        );
      }

      const updatedResult =
        await client.query(
          `
            UPDATE match_events
            SET
              team_id = $1,
              player_id = $2,
              type = $3,
              minute = $4,
              note = $5
            WHERE id = $6
              AND match_id = $7
            RETURNING *
          `,
          [
            teamId,
            playerId,
            type,
            minute,
            note,
            eventId,
            matchId
          ]
        );

      const updatedEvent =
        updatedResult.rows[0];

      /* Add new stat */

      const newStat =
        eventStatColumn(type);

      if (
        newStat &&
        playerId
      ) {
        await client.query(
          `
            UPDATE players
            SET ${newStat} =
              COALESCE(
                ${newStat},
                0
              ) + 1
            WHERE id = $1
          `,
          [playerId]
        );
      }

      await changePlayerRating(
        client,
        playerId,
        eventRatingDelta(type)
      );

      /* Add new goal */

      if (type === "goal" || type === "own_goal") {
        const isHome = Number(teamId) === Number(match.home_team_id);
        const homeAdd = type === "goal" ? (isHome ? 1 : 0) : (isHome ? 0 : 1);
        const awayAdd = type === "goal" ? (isHome ? 0 : 1) : (isHome ? 1 : 0);

        await client.query(
          `
            UPDATE matches
            SET
              home_score =
                home_score + $1,
              away_score =
                away_score + $2
            WHERE id = $3
          `,
          [
            homeAdd,
            awayAdd,
            matchId
          ]
        );
      }

      const finalMatchResult =
        await client.query(
          `
            SELECT *
            FROM matches
            WHERE id = $1
          `,
          [matchId]
        );

      await client.query("COMMIT");

      const fullEventResult =
        await query(
          `
            SELECT
              e.*,
              p.name AS player_name,
              p.photo AS player_photo,
              p.number AS player_number,
              p.position AS player_position,
              t.name AS team_name,
              t.logo AS team_logo
            FROM match_events e
            LEFT JOIN players p
              ON p.id = e.player_id
            LEFT JOIN teams t
              ON t.id = e.team_id
            WHERE e.id = $1
          `,
          [eventId]
        );

      res.json({
        ok: true,
        event:
          fullEventResult.rows[0],
        match:
          finalMatchResult.rows[0]
      });
    } catch (err) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch (_) {}

      console.error(
        "UPDATE EVENT ERROR:",
        err
      );

      res.status(400).json({
        ok: false,
        error:
          err.message
      });
    } finally {
      client.release();
    }
  }
);

/* =========================================================
   DELETE EVENT
========================================================= */

app.delete(
  "/api/matches/:matchId/events/:eventId",
  requireAdmin,
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      const matchId =
        intValue(
          req.params.matchId
        );

      const eventId =
        intValue(
          req.params.eventId
        );

      await client.query("BEGIN");

      const matchResult =
        await client.query(
          `
            SELECT *
            FROM matches
            WHERE id = $1
            FOR UPDATE
          `,
          [matchId]
        );

      if (
        !matchResult.rows.length
      ) {
        throw new Error(
          "Matç tapılmadı"
        );
      }

      const eventResult =
        await client.query(
          `
            SELECT *
            FROM match_events
            WHERE id = $1
              AND match_id = $2
            FOR UPDATE
          `,
          [
            eventId,
            matchId
          ]
        );

      if (
        !eventResult.rows.length
      ) {
        throw new Error(
          "Hadisə tapılmadı"
        );
      }

      const event =
        eventResult.rows[0];

      const stat =
        eventStatColumn(
          event.type
        );

      if (
        stat &&
        event.player_id
      ) {
        await client.query(
          `
            UPDATE players
            SET ${stat} =
              GREATEST(
                COALESCE(
                  ${stat},
                  0
                ) - 1,
                0
              )
            WHERE id = $1
          `,
          [event.player_id]
        );
      }

      await changePlayerRating(
        client,
        event.player_id,
        -eventRatingDelta(event.type)
      );

      if (
        event.type === "goal" ||
        event.type === "own_goal"
      ) {
        const match =
          matchResult.rows[0];

        const isHome = Number(event.team_id) === Number(match.home_team_id);
        const home = event.type === "goal"
          ? (isHome ? 1 : 0)
          : (isHome ? 0 : 1);
        const away = event.type === "goal"
          ? (isHome ? 0 : 1)
          : (isHome ? 1 : 0);

        await client.query(
          `
            UPDATE matches
            SET
              home_score =
                GREATEST(
                  home_score - $1,
                  0
                ),
              away_score =
                GREATEST(
                  away_score - $2,
                  0
                )
            WHERE id = $3
          `,
          [
            home,
            away,
            matchId
          ]
        );
      }

      await client.query(
        `
          DELETE FROM match_events
          WHERE id = $1
            AND match_id = $2
        `,
        [
          eventId,
          matchId
        ]
      );

      const updatedMatch =
        await client.query(
          `
            SELECT *
            FROM matches
            WHERE id = $1
          `,
          [matchId]
        );

      await client.query("COMMIT");

      res.json({
        ok: true,
        deleted_event_id:
          eventId,
        match:
          updatedMatch.rows[0]
      });
    } catch (err) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch (_) {}

      console.error(
        "DELETE EVENT ERROR:",
        err
      );

      res.status(400).json({
        ok: false,
        error:
          err.message
      });
    } finally {
      client.release();
    }
  }
);

/* =========================================================
   CARDS
========================================================= */

app.get(
  "/api/cards",
  async (req, res) => {
    try {
      const result =
        await query(`
          SELECT
            p.id,
            p.name,
            p.photo,
            p.yellow_cards,
            p.red_cards,
            p.team_id,
            t.name AS team_name
          FROM players p
          LEFT JOIN teams t
            ON t.id = p.team_id
          ORDER BY
            p.yellow_cards DESC,
            p.red_cards DESC,
            p.name ASC
        `);

      res.json({
        ok: true,
        cards:
          result.rows
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }
);

app.post(
  "/api/cards/change",
  requireAdmin,
  async (req, res) => {
    try {
      const playerId =
        intValue(
          req.body.player_id
        );

      const card =
        cleanString(
          req.body.card
        );

      const delta =
        intValue(
          req.body.delta,
          1
        );

      if (
        !playerId ||
        ![
          "yellow",
          "red"
        ].includes(card)
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Yanlış kart məlumatı"
        });
      }

      const column =
        card === "yellow"
          ? "yellow_cards"
          : "red_cards";

      const result =
        await query(
          `
            UPDATE players
            SET ${column} =
              GREATEST(
                COALESCE(
                  ${column},
                  0
                ) + $1,
                0
              )
            WHERE id = $2
            RETURNING *
          `,
          [
            delta,
            playerId
          ]
        );

      if (!result.rows.length) {
        return res.status(404).json({
          ok: false,
          error:
            "Oyunçu tapılmadı"
        });
      }

      if (delta > 0) {
        await notify(
          card,
          card === "yellow"
            ? "🟨 Sarı kart"
            : "🟥 Qırmızı kart",
          card === "yellow"
            ? "Oyunçu sarı kart aldı."
            : "Oyunçu qırmızı kart aldı.",
          {
            playerId,
            card
          }
        );
      }

      res.json({
        ok: true,
        player:
          result.rows[0]
      });
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err.message
      });
    }
  }
);

/* =========================================================
   BALLON D’OR 2026 — LIVE PREVIEW + IMMUTABLE FINAL SNAPSHOT
========================================================= */
const BDOR_2026_RULES = Object.freeze({
  goals: 3, assists: 2, saves: 1, mvp_count: 5,
  own_goals: -3, yellow_cards: -1, red_cards: -3
});

async function getBallonDorCandidates() {
  const result = await query(`
    SELECT p.id AS player_id, p.name AS player_name,
      COALESCE(t.name, '') AS team_name,
      COALESCE(p.goals,0)::INTEGER AS goals,
      COALESCE(p.assists,0)::INTEGER AS assists,
      COALESCE(p.saves,0)::INTEGER AS saves,
      COALESCE(p.own_goals,0)::INTEGER AS own_goals,
      COALESCE(p.yellow_cards,0)::INTEGER AS yellow_cards,
      COALESCE(p.red_cards,0)::INTEGER AS red_cards,
      COALESCE((SELECT COUNT(*) FROM matches mm WHERE mm.player_of_match_id=p.id),0)::INTEGER AS mvp_count
    FROM players p LEFT JOIN teams t ON t.id=p.team_id
  `);
  return result.rows.map(p => ({ ...p, score:
    Number(p.goals)*BDOR_2026_RULES.goals +
    Number(p.assists)*BDOR_2026_RULES.assists +
    Number(p.saves)*BDOR_2026_RULES.saves +
    Number(p.mvp_count)*BDOR_2026_RULES.mvp_count +
    Number(p.own_goals)*BDOR_2026_RULES.own_goals +
    Number(p.yellow_cards)*BDOR_2026_RULES.yellow_cards +
    Number(p.red_cards)*BDOR_2026_RULES.red_cards
  })).sort((a,b)=>b.score-a.score || b.goals-a.goals || b.assists-a.assists || a.player_name.localeCompare(b.player_name, 'az'));
}

app.get('/api/ballondor/2026', async (req,res) => {
  try {
    const snap = await query('SELECT * FROM ballondor_snapshots WHERE season=2026');
    if (snap.rows.length) {
      const players = await query('SELECT * FROM ballondor_snapshot_players WHERE snapshot_id=$1 ORDER BY rank ASC', [snap.rows[0].id]);
      return res.json({ok:true, finalized:true, snapshot:snap.rows[0], rules:snap.rows[0].scoring_rules, players:players.rows});
    }
    return res.json({ok:true, finalized:false, rules:BDOR_2026_RULES, players:(await getBallonDorCandidates()).slice(0,10)});
  } catch(err) { return res.status(500).json({ok:false,error:err.message}); }
});

app.post('/api/ballondor/2026/finalize', requireAdmin, async (req,res) => {
  const bakuDate = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Baku',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  if (bakuDate !== '2026-10-27') return res.status(403).json({ok:false,error:'Final nəticələri yalnız 27 oktyabr 2026-cı ildə dondurmaq olar (Bakı vaxtı).'});
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT id FROM ballondor_snapshots WHERE season=2026 FOR UPDATE');
    if (existing.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ok:false,error:'2026 nəticələri artıq dondurulub və dəyişdirilə bilməz.'});
    }
    const candidates = await getBallonDorCandidates();
    const inserted = await client.query(
      'INSERT INTO ballondor_snapshots(season,finalized_by,scoring_rules) VALUES(2026,$1,$2::jsonb) RETURNING *',
      [String(req.admin?.username || req.admin?.email || 'admin'), JSON.stringify(BDOR_2026_RULES)]
    );
    const snapshotId = inserted.rows[0].id;
    for (let i=0; i<candidates.length; i++) {
      const p=candidates[i];
      await client.query(`INSERT INTO ballondor_snapshot_players
        (snapshot_id,player_id,player_name,team_name,rank,score,goals,assists,saves,own_goals,yellow_cards,red_cards,mvp_count)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [snapshotId,p.player_id,p.player_name,p.team_name,i+1,p.score,p.goals,p.assists,p.saves,p.own_goals,p.yellow_cards,p.red_cards,p.mvp_count]);
    }
    await client.query('COMMIT');
    return res.json({ok:true,finalized:true,players:candidates.length,message:'Ballon d’Or 2026 nəticələri donduruldu.'});
  } catch(err) {
    try { await client.query('ROLLBACK'); } catch(_) {}
    return res.status(500).json({ok:false,error:err.message});
  } finally { client.release(); }
});

/* =========================================================
   STATISTICS
========================================================= */

app.get(
  "/api/statistics",
  async (req, res) => {
    try {
      const result =
        await query(`
          SELECT
            p.*,
            COALESCE((SELECT COUNT(*) FROM matches mm WHERE mm.player_of_match_id = p.id), 0)::INTEGER AS mvp_count,
            t.name AS team_name
          FROM players p
          LEFT JOIN teams t
            ON t.id = p.team_id
          ORDER BY
            p.goals DESC,
            p.assists DESC,
            p.saves DESC,
            p.name ASC
        `);

      res.json({
        ok: true,
        statistics:
          result.rows
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }
);

app.post(
  "/api/statistics/change",
  requireAdmin,
  async (req, res) => {
    try {
      const playerId =
        intValue(
          req.body.player_id
        );

      const stat =
        cleanString(
          req.body.stat
        );

      const delta =
        intValue(
          req.body.delta,
          1
        );

      const allowed = [
        "goals",
        "assists",
        "saves",
        "own_goals"
      ];

      if (
        !playerId ||
        !allowed.includes(stat)
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Yanlış statistika"
        });
      }

      const result =
        await query(
          `
            UPDATE players
            SET ${stat} =
              GREATEST(
                COALESCE(
                  ${stat},
                  0
                ) + $1,
                0
              )
            WHERE id = $2
            RETURNING *
          `,
          [
            delta,
            playerId
          ]
        );

      if (!result.rows.length) {
        return res.status(404).json({
          ok: false,
          error:
            "Oyunçu tapılmadı"
        });
      }

      res.json({
        ok: true,
        player:
          result.rows[0]
      });
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err.message
      });
    }
  }
);

/* =========================================================
   ALI AI — COMMIT ROUTES (REGULAR LEAGUE / CHAMPIONS LEAGUE)
========================================================= */
const AI_STAT_COLUMNS = new Set(["goals", "assists", "saves", "own_goals", "yellow_cards", "red_cards"]);
const AI_EVENT_MAP = { goal:"goals", assist:"assists", save:"saves", own_goal:"own_goals", yellow:"yellow_cards", red:"red_cards" };
const AI_EVENT_RATING = { goal:1, assist:0.5, save:0.5, own_goal:-2, yellow:-1, red:-3 };

app.post("/api/admin/ai/stat-commit", requireAdmin, async (req, res) => {
  const playerId = Number(req.body?.player_id);
  const stat = String(req.body?.stat || "");
  const delta = Number(req.body?.delta);
  const tournament = String(req.body?.tournament || "league").toLowerCase();
  if (!Number.isInteger(playerId) || playerId < 1 || !AI_STAT_COLUMNS.has(stat) || !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1000) {
    return res.status(400).json({ok:false,error:"Oyunçu, statistika və dəyişiklik düzgün deyil."});
  }
  if (!["league", "champions_league"].includes(tournament)) return res.status(400).json({ok:false,error:"Turnir düzgün seçilməyib."});
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const player = await client.query("SELECT id,name FROM players WHERE id=$1 FOR UPDATE", [playerId]);
    if (!player.rowCount) throw new Error("Oyunçu tapılmadı.");
    if (tournament === "champions_league") {
      await client.query(`INSERT INTO champions_league_player_stats(player_id,${stat},updated_at) VALUES($1,GREATEST($2,0),NOW())
        ON CONFLICT(player_id) DO UPDATE SET ${stat}=GREATEST(champions_league_player_stats.${stat}+$2,0),updated_at=NOW()`, [playerId, delta]);
    } else {
      await client.query(`UPDATE players SET ${stat}=GREATEST(COALESCE(${stat},0)+$1,0), rating=COALESCE(rating,0)+$2 WHERE id=$3`, [delta, (AI_EVENT_RATING[{goals:"goal",assists:"assist",saves:"save",own_goals:"own_goal",yellow_cards:"yellow",red_cards:"red"}[stat]] || 0) * delta, playerId]);
    }
    await client.query("COMMIT");
    const labels={goals:"qol",assists:"assist",saves:"seyv",own_goals:"avtoqol",yellow_cards:"sarı kart",red_cards:"qırmızı kart"};
    const tournamentLabel=tournament==="champions_league"?"Çempionlar Liqası":"adi liqa";
    const reply=`Hazırdır: ${player.rows[0].name} üçün ${labels[stat]} ${delta>0?"+":""}${delta} (${tournamentLabel}).`;
    await createNotification("ai","🤖 Ali AI",reply,{player_id:playerId,stat,delta,tournament});
    res.json({ok:true,changed:true,reply,tournament});
  } catch(err) {
    try { await client.query("ROLLBACK"); } catch(_) {}
    res.status(400).json({ok:false,error:err.message||"Statistika yadda saxlanmadı."});
  } finally { client.release(); }
});

app.post("/api/admin/ai/match-commit", requireAdmin, async (req, res) => {
  const b=req.body||{};
  const homeId=Number(b.home_team_id), awayId=Number(b.away_team_id);
  const homeScore=Number(b.home_score), awayScore=Number(b.away_score);
  const tournament=String(b.tournament||"league").toLowerCase();
  const events=Array.isArray(b.events)?b.events:[];
  const matchStatus=["scheduled","live","finished"].includes(String(b.status||"finished"))?String(b.status||"finished"):"finished";
  if (!Number.isInteger(homeId)||!Number.isInteger(awayId)||homeId===awayId||![homeScore,awayScore].every(Number.isInteger)||homeScore<0||awayScore<0||homeScore>99||awayScore>99)
    return res.status(400).json({ok:false,error:"Matç komandalarını və hesabı yoxla."});
  if (!["league","champions_league"].includes(tournament)) return res.status(400).json({ok:false,error:"Turnir düzgün seçilməyib."});
  if (events.length>500) return res.status(400).json({ok:false,error:"Matç hadisələrinin sayı çoxdur."});
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    const teamsResult=await client.query("SELECT id FROM teams WHERE id=ANY($1::int[])",[ [homeId,awayId] ]);
    if(teamsResult.rowCount!==2) throw new Error("Komandalardan biri tapılmadı.");
    const playerIds=[...new Set(events.map(e=>Number(e.player_id)).filter(Number.isInteger))];
    const playerRows=playerIds.length?await client.query("SELECT id,team_id,name FROM players WHERE id=ANY($1::int[])",[playerIds]):{rows:[]};
    const playerMap=new Map(playerRows.rows.map(p=>[Number(p.id),p]));
    if(b.player_of_match_id){
      const mvp=await client.query("SELECT id,team_id,name FROM players WHERE id=$1",[Number(b.player_of_match_id)]);
      if(!mvp.rowCount || ![homeId,awayId].includes(Number(mvp.rows[0].team_id))) throw new Error("MVP oyunçusu bu matçın komandalarından olmalıdır.");
    }
    for(const e of events){
      const pid=Number(e.player_id),tid=Number(e.team_id),type=String(e.type||"");
      if(!AI_EVENT_MAP[type]) throw new Error("Matçda dəstəklənməyən hadisə var: "+type);
      const pl=playerMap.get(pid);
      if(!pl) throw new Error("Hadisədə oyunçu tapılmadı.");
      if(![homeId,awayId].includes(tid)||Number(pl.team_id)!==tid) throw new Error(`${pl.name}: komanda seçimi düzgün deyil.`);
    }
    let matchId;
    if(tournament==="champions_league"){
      const existing=await client.query(`SELECT id FROM champions_league_matches WHERE home_team_id=$1 AND away_team_id=$2 ORDER BY CASE WHEN status='scheduled' THEN 0 ELSE 1 END,leg,id LIMIT 1 FOR UPDATE`,[homeId,awayId]);
      if(existing.rowCount){
        matchId=Number(existing.rows[0].id);
        await client.query(`UPDATE champions_league_matches SET home_score=$1,away_score=$2,status='finished' WHERE id=$3`,[homeScore,awayScore,matchId]);
      } else {
        const created=await client.query(`INSERT INTO champions_league_matches(home_team_id,away_team_id,home_score,away_score,status) VALUES($1,$2,$3,$4,'finished') RETURNING id`,[homeId,awayId,homeScore,awayScore]);
        matchId=Number(created.rows[0].id);
      }
      const perPlayer={};
      for(const e of events){const pid=Number(e.player_id),col=AI_EVENT_MAP[e.type];perPlayer[pid] ||= {goals:0,assists:0,saves:0,own_goals:0,yellow_cards:0,red_cards:0};perPlayer[pid][col]++;}
      for(const [pid,stats] of Object.entries(perPlayer)){
        await client.query(`INSERT INTO champions_league_player_stats(player_id,goals,assists,saves,own_goals,yellow_cards,red_cards,appearances,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,1,NOW()) ON CONFLICT(player_id) DO UPDATE SET goals=champions_league_player_stats.goals+$2,assists=champions_league_player_stats.assists+$3,saves=champions_league_player_stats.saves+$4,own_goals=champions_league_player_stats.own_goals+$5,yellow_cards=champions_league_player_stats.yellow_cards+$6,red_cards=champions_league_player_stats.red_cards+$7,appearances=champions_league_player_stats.appearances+1,updated_at=NOW()`,[Number(pid),stats.goals,stats.assists,stats.saves,stats.own_goals,stats.yellow_cards,stats.red_cards]);
      }
      if(b.player_of_match_id && !perPlayer[Number(b.player_of_match_id)]){
        await client.query(`INSERT INTO champions_league_player_stats(player_id,appearances,updated_at) VALUES($1,1,NOW()) ON CONFLICT(player_id) DO UPDATE SET appearances=champions_league_player_stats.appearances+1,updated_at=NOW()`,[Number(b.player_of_match_id)]);
      }
    } else {
      const created=await client.query(`INSERT INTO matches(home_team_id,away_team_id,home_score,away_score,status,match_date,player_of_match_id) VALUES($1,$2,$3,$4,$5,COALESCE($6::timestamp,NOW()),$7) RETURNING id`,[homeId,awayId,homeScore,awayScore,matchStatus,b.match_date||null,b.player_of_match_id?Number(b.player_of_match_id):null]);
      matchId=Number(created.rows[0].id);
      for(const e of events){
        await client.query(`INSERT INTO match_events(match_id,team_id,player_id,type,minute,note) VALUES($1,$2,$3,$4,$5,$6)`,[matchId,Number(e.team_id),Number(e.player_id),String(e.type),Math.max(0,Number(e.minute)||0),String(e.note||"")]);
        const col=AI_EVENT_MAP[e.type];
        await client.query(`UPDATE players SET ${col}=COALESCE(${col},0)+1,rating=COALESCE(rating,0)+$1 WHERE id=$2`,[AI_EVENT_RATING[e.type]||0,Number(e.player_id)]);
      }
    }
    await client.query("COMMIT");
    const tournamentLabel=tournament==="champions_league"?"Çempionlar Liqası":"adi liqa";
    const reply=`${tournamentLabel} matçı yadda saxlanıldı; statistika yalnız həmin turnirə əlavə edildi.`;
    await createNotification("ai","🤖 Ali AI",reply,{match_id:matchId,tournament});
    res.json({ok:true,match_id:matchId,tournament,reply});
  } catch(err){
    try{await client.query("ROLLBACK");}catch(_){}
    console.error("ALI AI MATCH COMMIT ERROR:",err);
    res.status(400).json({ok:false,error:err.message||"Matç yadda saxlanmadı."});
  } finally {client.release();}
});

/* =========================================================
   ALI AI — ADMIN STATISTICS ASSISTANT
========================================================= */

app.post("/api/admin/ai", requireAdmin, async (req, res) => {
  try {
    const message = cleanString(req.body?.message);
    if (!message) {
      return res.status(400).json({ ok:false, error:"Ali AI üçün mesaj yazın." });
    }

    const normalizeAiText = (value) => String(value || "")
      .toLowerCase()
      .replace(/ə/g, "e")
      .replace(/ı/g, "i")
      .replace(/ö/g, "o")
      .replace(/ü/g, "u")
      .replace(/ş/g, "s")
      .replace(/ç/g, "c")
      .replace(/ğ/g, "g")
      .replace(/[’'`]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
    const normalized = normalizeAiText(message);
    const statMap = [
      { key:"own_goals", words:["avtoqol","autogol","own goal","own_goal"] },
      { key:"goals", words:["qol","gol","goal"] },
      { key:"assists", words:["assist","asist"] },
      { key:"saves", words:["seyv","save"] },
      { key:"yellow_cards", words:["sari kart","yellow"] },
      { key:"red_cards", words:["qirmizi kart","red"] }
    ];

    let stat = null;
    for (const item of statMap) {
      if (item.words.some(w => normalized.includes(w))) { stat = item.key; break; }
    }

    const numberMatch = normalized.match(/(?:^|\s)(\d+(?:[.,]\d+)?)(?:\s|$)/);
    const amount = numberMatch ? Math.trunc(Number(numberMatch[1].replace(",", "."))) : 1;
    if (!Number.isFinite(amount) || amount < 1 || amount > 1000) {
      return res.status(400).json({ ok:false, error:"Dəyişiklik sayı 1–1000 aralığında olmalıdır." });
    }

    if (!stat) {
      return res.json({
        ok:true,
        changed:false,
        reply:"Mən statistikanı dəyişmək üçün oyunçu adını və göstəricini yazmağını gözləyirəm. Məsələn: “Aliyə 2 qol əlavə et” və ya “Ramilin avtoqolunu 1 artır”."
      });
    }

    const all = await query(`SELECT p.*, t.name AS team_name FROM players p LEFT JOIN teams t ON t.id = p.team_id ORDER BY p.name ASC`);

    // Match whole player names, not arbitrary substrings. In particular,
    // "Amil" must never be treated as a match inside "Ramil" (or vice versa).
    // Azerbaijani/Russian possessive and case endings are accepted after a name.
    const candidates = all.rows.filter((p) => {
      const playerName = normalizeAiText(p.name);
      if (!playerName) return false;
      const escapedName = playerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(
        "(^|\\s)" + escapedName + "(?=$|\\s|in\\b|ın\\b|un\\b|ün\\b|nin\\b|nın\\b|nun\\b|nün\\b|e\\b|ə\\b|a\\b|i\\b|u\\b|ı\\b|ni\\b|nı\\b|nu\\b|nü\\b)"
      );
      return pattern.test(normalized);
    });
    if (candidates.length !== 1) {
      const names = candidates.map(p => `${p.name}${p.team_name ? ` (${p.team_name})` : ""}`);
      return res.status(400).json({
        ok: false,
        code: candidates.length ? "PLAYER_AMBIGUOUS" : "PLAYER_NOT_FOUND",
        candidates: candidates.map(p => ({ id: p.id, name: p.name, team_name: p.team_name })),
        error: candidates.length
          ? `Dəqiqləşdir: ${names.join(" və ")}. Hansı oyunçunu nəzərdə tutursan?`
          : "Oyunçu tapılmadı. Adı bazadakı kimi tam yazın."
      });
    }

    const player = candidates[0];
    const negative = /azalt|sil|minus|geri al|cix/.test(normalized);
    const delta = negative ? -amount : amount;

    const column = ["goals","assists","saves","own_goals","yellow_cards","red_cards"].includes(stat) ? stat : null;
    if (!column) return res.status(400).json({ok:false,error:"Bu statistika dəstəklənmir."});

    const result = await query(
      `UPDATE players SET ${column}=GREATEST(COALESCE(${column},0)+$1,0) WHERE id=$2 RETURNING *`,
      [delta, player.id]
    );

    const labels = {goals:"qol",assists:"assist",saves:"sevy",own_goals:"avtoqol",yellow_cards:"sarı kart",red_cards:"qırmızı kart"};
    await createNotification(
      "ai",
      "🤖 Ali AI",
      `${player.name}: ${labels[stat]} ${delta > 0 ? "+" : ""}${delta}`,
      { player_id: player.id, stat, delta }
    );

    res.json({
      ok:true,
      changed:true,
      player:result.rows[0],
      reply:`Hazırdır: ${player.name} üçün ${labels[stat]} göstəricisi ${delta > 0 ? "+" : ""}${delta} dəyişdirildi.`
    });
  } catch (err) {
    console.error("ALI AI ERROR:", err);
    res.status(500).json({ ok:false, error:"Ali AI xətası: " + err.message });
  }
});

/* =========================================================
   NOTIFICATIONS
========================================================= */

app.get(
  "/api/notifications",
  async (req, res) => {
    try {
      const result =
        await query(`
          SELECT *
          FROM notifications
          ORDER BY
            created_at DESC,
            id DESC
          LIMIT 100
        `);

      res.json({
        ok: true,
        notifications:
          result.rows
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }
);

/* =========================================================
   TRANSFERS
========================================================= */

app.get(
  "/api/transfers",
  async (req, res) => {
    try {
      const result =
        await query(`
          SELECT
            tr.*,
            p.name AS player_name,
            p.photo AS player_photo,
            ft.name AS from_team_name,
            tt.name AS to_team_name
          FROM transfers tr
          LEFT JOIN players p
            ON p.id = tr.player_id
          LEFT JOIN teams ft
            ON ft.id = tr.from_team_id
          LEFT JOIN teams tt
            ON tt.id = tr.to_team_id
          ORDER BY
            tr.created_at DESC,
            tr.id DESC
        `);

      res.json({
        ok: true,
        transfers:
          result.rows
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }
);

app.post(
  "/api/transfers",
  requireAdmin,
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      const playerId =
        intValue(
          req.body.player_id
        );

      const toTeamId =
        intValue(
          req.body.to_team_id
        );

      const note =
        cleanString(
          req.body.note
        );

      const fee =
        Math.max(
          0,
          numberValue(
            req.body.fee !== undefined
              ? req.body.fee
              : req.body.price,
            0
          )
        );

      if (!playerId || !toTeamId) {
        throw new Error(
          "Oyunçu və yeni komanda seçilməlidir"
        );
      }

      await client.query("BEGIN");

      const playerResult =
        await client.query(
          `
            SELECT *
            FROM players
            WHERE id = $1
            FOR UPDATE
          `,
          [playerId]
        );

      if (
        !playerResult.rows.length
      ) {
        throw new Error(
          "Oyunçu tapılmadı"
        );
      }

      const player =
        playerResult.rows[0];

      if (
        Number(player.team_id) ===
        Number(toTeamId)
      ) {
        throw new Error(
          "Oyunçu artıq bu komandadadır"
        );
      }

      const teamResult =
        await client.query(
          `
            SELECT *
            FROM teams
            WHERE id = $1
          `,
          [toTeamId]
        );

      if (
        !teamResult.rows.length
      ) {
        throw new Error(
          "Yeni komanda tapılmadı"
        );
      }

      const fromTeamId =
        player.team_id;

      await client.query(
        `
          UPDATE players
          SET
            team_id = $1,
            transfer_value = CASE
              WHEN $3 > 0 THEN $3
              ELSE COALESCE(transfer_value, 0)
            END
          WHERE id = $2
        `,
        [
          toTeamId,
          playerId,
          fee
        ]
      );

      const transferResult =
        await client.query(
          `
            INSERT INTO transfers
              (
                player_id,
                from_team_id,
                to_team_id,
                note,
                fee
              )
            VALUES
              ($1, $2, $3, $4, $5)
            RETURNING *
          `,
          [
            playerId,
            fromTeamId,
            toTeamId,
            note,
            fee
          ]
        );

      await client.query("COMMIT");

      await notify(
        "transfer",
        "🔄 Transfer",
        `${player.name} yeni komandaya keçdi.`,
        {
          playerId,
          fromTeamId,
          toTeamId
        }
      );

      res.json({
        ok: true,
        transfer:
          transferResult.rows[0]
      });
    } catch (err) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch (_) {}

      res.status(400).json({
        ok: false,
        error: err.message
      });
    } finally {
      client.release();
    }
  }
);

/* =========================================================
   TEAM OF THE WEEK
========================================================= */

app.get(
  "/api/team-of-week",
  async (req, res) => {
    try {
      const result = await query(`
        SELECT
          twp.id,
          twp.team_of_week_id,
          twp.position,
          twp.player_id,
          p.name,
          p.photo,
          p.number,
          p.team_id,
          t.name AS team_name,
          tw.week
        FROM team_of_week_players twp
        JOIN team_of_week tw
          ON tw.id = twp.team_of_week_id
        LEFT JOIN players p
          ON p.id = twp.player_id
        LEFT JOIN teams t
          ON t.id = p.team_id
        WHERE tw.id = (SELECT id FROM team_of_week ORDER BY created_at DESC, id DESC LIMIT 1)
        ORDER BY
          CASE twp.position
            WHEN 'Qapıçı' THEN 1
            WHEN 'Müdafiəçi' THEN 2
            WHEN 'Müdafiə' THEN 2
            WHEN 'Yarımmüdafiəçi' THEN 3
            WHEN 'Yarımmüdafiə' THEN 3
            WHEN 'Hücumçu' THEN 4
            WHEN 'Hücum' THEN 4
            ELSE 5
          END,
          twp.id ASC
      `);

      if (result.rows.length) {
        return res.json(result.rows);
      }

      // Compatibility fallback for old databases that only have the 4 player columns.
      const legacy = await query(`
        SELECT
          tw.id,
          tw.week,
          p.id AS player_id,
          p.name,
          p.photo,
          p.number,
          p.team_id,
          t.name AS team_name,
          v.position
        FROM team_of_week tw
        CROSS JOIN LATERAL (VALUES
          (tw.goalkeeper_id, 'Qapıçı'),
          (tw.defender_id, 'Müdafiəçi'),
          (tw.midfielder_id, 'Yarımmüdafiəçi'),
          (tw.attacker_id, 'Hücumçu')
        ) AS v(player_id, position)
        LEFT JOIN players p ON p.id = v.player_id
        LEFT JOIN teams t ON t.id = p.team_id
        WHERE tw.id = (SELECT id FROM team_of_week ORDER BY created_at DESC, id DESC LIMIT 1)
          AND v.player_id IS NOT NULL
        ORDER BY v.position
      `);

      return res.json(legacy.rows);
    } catch (err) {
      console.error("GET TEAM OF WEEK ERROR:", err);
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

app.post(
  "/api/team-of-week",
  requireAdmin,
  async (req, res) => {
    const client = await pool.connect();
    try {
      const week = cleanString(req.body.week) || new Date().toISOString().slice(0, 10);
      let players = Array.isArray(req.body.players) ? req.body.players : null;

      // Support the older 4-player API as well.
      if (!players) {
        players = [
          { player_id: req.body.goalkeeper_id, position: 'Qapıçı' },
          { player_id: req.body.defender_id, position: 'Müdafiəçi' },
          { player_id: req.body.midfielder_id, position: 'Yarımmüdafiəçi' },
          { player_id: req.body.attacker_id, position: 'Hücumçu' }
        ];
      }

      players = players.map(x => ({
        player_id: nullableInt(x.player_id ?? x.playerId ?? x.id),
        position: cleanString(x.position)
      })).filter(x => x.player_id);

      if (players.length !== (Array.isArray(req.body.players) ? 11 : 4)) {
        return res.status(400).json({ ok: false, error: Array.isArray(req.body.players) ? '11 oyunçu seçilməlidir' : 'Bütün 4 mövqe seçilməlidir' });
      }

      if (new Set(players.map(x => x.player_id)).size !== players.length) {
        return res.status(400).json({ ok: false, error: 'Eyni oyunçu iki dəfə seçilə bilməz' });
      }

      if (players.length === 11) {
        const counts = { 'Qapıçı': 0, 'Müdafiəçi': 0, 'Yarımmüdafiəçi': 0, 'Hücumçu': 0 };
        for (const item of players) {
          if (counts[item.position] === undefined) {
            return res.status(400).json({ ok: false, error: 'Mövqe düzgün deyil' });
          }
          counts[item.position]++;
        }
        if (counts['Qapıçı'] !== 1 || counts['Müdafiəçi'] !== 4 || counts['Yarımmüdafiəçi'] !== 3 || counts['Hücumçu'] !== 3) {
          return res.status(400).json({ ok: false, error: 'Düzülüş: 1 Qapıçı, 4 Müdafiəçi, 3 Yarımmüdafiəçi, 3 Hücumçu' });
        }
      }

      const ids = players.map(x => x.player_id);
      const existing = await client.query('SELECT id FROM players WHERE id = ANY($1::int[])', [ids]);
      if (existing.rows.length !== ids.length) {
        return res.status(400).json({ ok: false, error: 'Seçilmiş oyunçulardan biri tapılmadı' });
      }

      await client.query('BEGIN');
      await client.query('DELETE FROM team_of_week');

      const g = players.find(x => x.position === 'Qapıçı')?.player_id || null;
      const d = players.find(x => x.position === 'Müdafiəçi')?.player_id || null;
      const m = players.find(x => x.position === 'Yarımmüdafiəçi')?.player_id || null;
      const a = players.find(x => x.position === 'Hücumçu')?.player_id || null;

      const weekResult = await client.query(`
        INSERT INTO team_of_week (week, goalkeeper_id, defender_id, midfielder_id, attacker_id)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, week, created_at
      `, [week, g, d, m, a]);

      const weekId = weekResult.rows[0].id;
      for (const item of players) {
        await client.query(`
          INSERT INTO team_of_week_players (team_of_week_id, player_id, position)
          VALUES ($1, $2, $3)
        `, [weekId, item.player_id, item.position]);
      }

      await client.query('COMMIT');

      await notify('team-of-week', '⭐ Komanda həftəsi', 'Yeni Komanda həftəsi seçildi!', { id: weekId, week });

      res.json({ ok: true, teamOfWeek: weekResult.rows[0] });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('SAVE TEAM OF WEEK ERROR:', err);
      res.status(400).json({ ok: false, error: err.message });
    } finally {
      client.release();
    }
  }
);

/* =========================================================
   LINEUPS
========================================================= */

app.get("/api/lineups/:id", async (req, res) => {
  try {
    const matchId = intValue(req.params.id);
    const result = await query(`
      SELECT
        lp.id, lp.match_id, lp.team_id, lp.player_id, lp.position,
        p.name, p.number, p.photo, p.team_id AS player_team_id,
        t.name AS team_name
      FROM lineup_players lp
      LEFT JOIN players p ON p.id = lp.player_id
      LEFT JOIN teams t ON t.id = lp.team_id
      WHERE lp.match_id = $1
      ORDER BY lp.id ASC
    `, [matchId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/lineups", requireAdmin, async (req, res) => {
  try {
    const matchId = intValue(req.body.match_id);
    const playerId = intValue(req.body.player_id);
    const position = cleanString(req.body.position);
    if (!matchId || !playerId || !position) {
      return res.status(400).json({ ok: false, error: "Matç, oyunçu və mövqe tələb olunur" });
    }
    const player = await query("SELECT id, team_id, name FROM players WHERE id = $1", [playerId]);
    if (!player.rows.length) return res.status(404).json({ ok: false, error: "Oyunçu tapılmadı" });
    const unavailable = await query("SELECT status, reason FROM player_availability WHERE player_id=$1 AND active=TRUE ORDER BY created_at DESC LIMIT 1", [playerId]);
    if (unavailable.rows.length) {
      const label = unavailable.rows[0].status === 'injury' ? 'zədəli' : 'diskvalifikasiya olunub';
      return res.status(400).json({ ok: false, error: `${player.rows[0].name} hazırda ${label}; rəsmi heyətə əlavə edilə bilməz.` });
    }
    const exists = await query("SELECT id FROM lineup_players WHERE match_id=$1 AND player_id=$2", [matchId, playerId]);
    if (exists.rows.length) return res.status(400).json({ ok: false, error: "Bu oyunçu artıq heyətdədir" });
    const result = await query(`
      INSERT INTO lineup_players (match_id, team_id, player_id, position)
      VALUES ($1,$2,$3,$4) RETURNING *
    `, [matchId, player.rows[0].team_id, playerId, position]);
    res.status(201).json({ ok: true, lineup: result.rows[0] });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete("/api/lineups/:id/:playerId", requireAdmin, async (req, res) => {
  try {
    await query("DELETE FROM lineup_players WHERE match_id=$1 AND player_id=$2", [intValue(req.params.id), intValue(req.params.playerId)]);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/* =========================================================
   PLAYER AVAILABILITY — injuries and suspensions
========================================================= */
app.get("/api/availability", async (req, res) => {
  try {
    // Injuries with a return date are automatically cleared on that date.
    await query("UPDATE player_availability SET active=FALSE, updated_at=NOW() WHERE active=TRUE AND status='injury' AND return_date IS NOT NULL AND return_date <= CURRENT_DATE");
    const result = await query(`
      SELECT pa.id, pa.player_id, pa.status, pa.reason, pa.return_date,
             pa.matches_remaining, pa.notes, pa.active, pa.created_at, pa.updated_at,
             p.name AS player_name, p.photo AS player_photo, p.position,
             p.team_id, t.name AS team_name
      FROM player_availability pa
      JOIN players p ON p.id = pa.player_id
      LEFT JOIN teams t ON t.id = p.team_id
      WHERE pa.active = TRUE
      ORDER BY CASE pa.status WHEN 'injury' THEN 0 ELSE 1 END, pa.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('AVAILABILITY LIST ERROR:', err);
    res.status(500).json({ ok: false, error: 'Zədə və cəza siyahısını yükləmək olmadı' });
  }
});

app.post("/api/availability", requireAdmin, async (req, res) => {
  try {
    const playerId = intValue(req.body.player_id);
    const status = cleanString(req.body.status).toLowerCase();
    const reason = cleanString(req.body.reason).slice(0, 240);
    const notes = cleanString(req.body.notes).slice(0, 1000);
    const returnDate = cleanString(req.body.return_date) || null;
    const matchesRemaining = Math.max(0, Math.min(100, intValue(req.body.matches_remaining) || 0));
    if (!playerId) return res.status(400).json({ ok: false, error: 'Oyunçu seçilməlidir' });
    if (!['injury','suspension'].includes(status)) return res.status(400).json({ ok: false, error: 'Status düzgün deyil' });
    const player = await query('SELECT id FROM players WHERE id=$1', [playerId]);
    if (!player.rows.length) return res.status(404).json({ ok: false, error: 'Oyunçu tapılmadı' });
    if (returnDate && !/^\d{4}-\d{2}-\d{2}$/.test(returnDate)) return res.status(400).json({ ok: false, error: 'Tarix düzgün deyil' });
    const result = await query(`
      INSERT INTO player_availability (player_id,status,reason,return_date,matches_remaining,notes,active)
      VALUES ($1,$2,$3,$4,$5,$6,TRUE)
      RETURNING *
    `, [playerId, status, reason, returnDate, matchesRemaining, notes]);
    res.status(201).json({ ok: true, availability: result.rows[0] });
  } catch (err) {
    console.error('AVAILABILITY CREATE ERROR:', err);
    res.status(400).json({ ok: false, error: err.message || 'Statusı yadda saxlamaq olmadı' });
  }
});

app.post("/api/availability/:id/match-missed", requireAdmin, async (req, res) => {
  try {
    const id = intValue(req.params.id);
    const result = await query(`
      UPDATE player_availability
      SET matches_remaining = GREATEST(matches_remaining - 1, 0),
          active = CASE WHEN status='suspension' AND matches_remaining <= 1 THEN FALSE ELSE active END,
          updated_at = NOW()
      WHERE id=$1 AND active=TRUE AND status='suspension'
      RETURNING *
    `, [id]);
    if (!result.rows.length) return res.status(404).json({ ok: false, error: 'Aktiv diskvalifikasiya tapılmadı' });
    res.json({ ok: true, availability: result.rows[0] });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete("/api/availability/:id", requireAdmin, async (req, res) => {
  try {
    const id = intValue(req.params.id);
    const result = await query(`UPDATE player_availability SET active=FALSE, updated_at=NOW() WHERE id=$1 AND active=TRUE RETURNING id` , [id]);
    if (!result.rows.length) return res.status(404).json({ ok: false, error: 'Aktiv status tapılmadı' });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

/* =========================================================
   PUSH
========================================================= */

app.get("/api/push/public-key", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const configured = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
  res.status(configured ? 200 : 503).json({
    ok: configured,
    enabled: pushEnabled,
    configured,
    publicKey: VAPID_PUBLIC_KEY || null,
    serviceWorker: "/service-worker.js",
    error: configured ? null : "VAPID_PUBLIC_KEY və VAPID_PRIVATE_KEY Render Environment-də yoxdur."
  });
});

app.post("/api/push/subscribe", async (req, res) => {
  try {
    if (!pushEnabled) {
      return res.status(503).json({
        ok: false,
        error: "Web Push disabled. Check VAPID keys in Render Environment."
      });
    }

    const subscription =
        req.body.subscription ||
        req.body;

      if (
        !subscription ||
        !subscription.endpoint ||
        !subscription.keys ||
        !subscription.keys.p256dh ||
        !subscription.keys.auth
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Invalid push subscription"
        });
      }

      await query(
        `
          INSERT INTO push_subscriptions
            (
              endpoint,
              p256dh,
              auth
            )
          VALUES
            ($1, $2, $3)
          ON CONFLICT (endpoint)
          DO UPDATE SET
            p256dh =
              EXCLUDED.p256dh,
            auth =
              EXCLUDED.auth
        `,
        [
          subscription.endpoint,
          subscription.keys.p256dh,
          subscription.keys.auth
        ]
      );

      res.json({
        ok: true
      });
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err.message
      });
    }
  }
);

app.post(
  "/api/push/test",
  requireAdmin,
  async (req, res) => {
    try {
      const result = await sendPush(
        "AliScore",
        "Push bildirişləri işləyir! ⚽",
        { test: true, type: "test" }
      );

      if (!pushEnabled) {
        return res.status(503).json({ ok:false, error:"Push aktiv deyil. Render Environment-də VAPID_PUBLIC_KEY və VAPID_PRIVATE_KEY yoxlanmalıdır.", push:result });
      }
      if (!result.total) {
        return res.status(409).json({ ok:false, error:"Heç bir telefon push-a abunə olmayıb. Əvvəl Bildirişləri aktiv et düyməsinə bas.", push:result });
      }
      if (!result.sent) {
        return res.status(502).json({
          ok:false,
          error:"Push server tərəfindən qəbul edilmədi.",
          push:result
        });
      }
      res.json({ ok:true, message:`Test bildirişi göndərildi: ${result.sent}/${result.total}`, push:result });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }
);

/* =========================================================
   SERVICE WORKER
========================================================= */

app.get("/service-worker.js", (req, res) => {
  res.type("application/javascript");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.send(`
const CACHE_NAME = "aliscore-push-v5";
self.addEventListener("install", event => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("push", event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { title: "AliScore", body: event.data ? event.data.text() : "Yeni bildiriş" };
  }
  const title = data.title || "AliScore";
  const options = {
    body: data.body || "AliScore-da yeni hadisə var.",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: data.data || {},
    tag: data.data && data.data.type ? "aliscore-" + data.data.type : "aliscore-" + Date.now(),
    renotify: true,
    requireInteraction: false
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
`);
});

/* =========================================================
   PUSH STATUS
========================================================= */
app.get("/api/push/status", async (req, res) => {
  try {
    const result = await query("SELECT COUNT(*)::int AS count FROM push_subscriptions");
    res.json({
      ok: true,
      enabled: pushEnabled,
      configured: !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY),
      subscriptions: result.rows[0]?.count || 0,
      publicKey: VAPID_PUBLIC_KEY || null,
      lastPush: lastPushResult
    });
  } catch (err) {
    res.status(500).json({ ok:false, enabled:pushEnabled, configured:!!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY), subscriptions:0, error:err.message });
  }
});


/* =========================================================
   ADMIN CENTER 2.0
========================================================= */
app.get("/api/admin-center/status", requireAdmin, async (req, res) => {
  try {
    await query("SELECT 1");
    const [teams, players, matches, logs, backup] = await Promise.all([
      query("SELECT COUNT(*)::int AS count FROM teams"),
      query("SELECT COUNT(*)::int AS count FROM players"),
      query("SELECT COUNT(*)::int AS count FROM matches"),
      query("SELECT COUNT(*)::int AS count FROM admin_audit_log"),
      query("SELECT created_at FROM admin_audit_log WHERE path='/api/admin-center/backup' ORDER BY id DESC LIMIT 1")
    ]);
    res.json({
      ok: true, server: "aktiv", database: "connected",
      counts: { teams: teams.rows[0]?.count || 0, players: players.rows[0]?.count || 0, matches: matches.rows[0]?.count || 0, adminActions: logs.rows[0]?.count || 0 },
      pushConfigured: !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY),
      lastBackup: backup.rows[0]?.created_at || null, time: new Date().toISOString()
    });
  } catch (err) { res.status(500).json({ ok: false, error: "Sistem statusunu oxumaq olmadı" }); }
});
app.get("/api/admin-center/logs", requireAdmin, async (req, res) => {
  try {
    const result = await query("SELECT id, action, method, path, status_code, created_at FROM admin_audit_log ORDER BY id DESC LIMIT 40");
    res.json({ ok: true, logs: result.rows });
  } catch (err) { res.status(500).json({ ok: false, error: "Əməliyyat jurnalını oxumaq olmadı" }); }
});
app.get("/api/admin-center/backup", requireAdmin, async (req, res) => {
  try {
    const names = await getSnapshotTableNames();
    const tables = {};
    for (const name of names) {
      const result = await query(`SELECT * FROM ${quoteIdent(name)}`);
      tables[name] = result.rows;
    }
    await writeAdminLog("Verilənlər bazasının ehtiyat nüsxəsi yaradıldı", "GET", "/api/admin-center/backup", 200);
    res.json({ ok: true, product: "AliScore", backupVersion: 1, createdAt: new Date().toISOString(), tables });
  } catch (err) { res.status(500).json({ ok: false, error: "Ehtiyat nüsxəsini yaratmaq olmadı" }); }
});
app.post("/api/admin-center/undo", requireAdmin, async (req, res) => {
  if (!req.body || req.body.confirm !== true) return res.status(400).json({ ok: false, error: "Bərpanı təsdiqləmək lazımdır" });
  const client = await pool.connect();
  try {
    const snap = await client.query("SELECT snapshot FROM admin_undo_snapshots WHERE id=1");
    if (!snap.rows.length) return res.status(404).json({ ok: false, error: "Geri qaytarmaq üçün əvvəlki admin əməliyyatı yoxdur" });
    const snapshot = snap.rows[0].snapshot || {};
    const names = Object.keys(snapshot).filter(n => !ADMIN_META_TABLES.has(n));
    await client.query("BEGIN");
    if (names.length) {
      await client.query(`TRUNCATE TABLE ${names.map(quoteIdent).join(", ")} RESTART IDENTITY CASCADE`);
      const ordered = await orderTablesForRestore(client, names);
      for (const name of ordered) {
        const rows = Array.isArray(snapshot[name]) ? snapshot[name] : [];
        if (rows.length) {
          await client.query(`INSERT INTO ${quoteIdent(name)} SELECT * FROM jsonb_populate_recordset(NULL::${quoteIdent(name)}, $1::jsonb)`, [JSON.stringify(rows)]);
        }
      }
      for (const name of names) {
        const seq = await client.query("SELECT pg_get_serial_sequence($1, 'id') AS seq", [`public.${name}`]);
        const sequence = seq.rows[0]?.seq;
        if (sequence) {
          const max = await client.query(`SELECT COALESCE(MAX(id), 0)::bigint AS max_id FROM ${quoteIdent(name)}`);
          const maxId = Number(max.rows[0]?.max_id || 0);
          await client.query("SELECT setval($1, $2, $3)", [sequence, Math.max(maxId, 1), maxId > 0]);
        }
      }
    }
    await client.query("COMMIT");
    await writeAdminLog("Son admin dəyişikliyi geri qaytarıldı", "POST", "/api/admin-center/undo", 200);
    res.json({ ok: true, message: "Əvvəlki məlumat vəziyyəti bərpa edildi." });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("ADMIN UNDO ERROR:", err);
    res.status(500).json({ ok: false, error: "Geri qaytarma alınmadı. " + (err.message || "") });
  } finally { client.release(); }
});

/* =========================================================
   UNKNOWN API
========================================================= */

// Texniki işlər: only authenticated admins can switch maintenance mode.
app.get("/api/maintenance/status", async (req, res) => {
  try {
    const result = await query("SELECT value FROM site_settings WHERE key='maintenance_mode' LIMIT 1");
    const enabled = result.rows[0]?.value === "on";
    res.json({ ok: true, enabled, admin: !!verifyAdminToken(getAdminToken(req)) });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Texniki işlər statusunu oxumaq olmadı" });
  }
});
app.post("/api/maintenance/toggle", requireAdmin, async (req, res) => {
  try {
    const enabled = !!(req.body && req.body.enabled);
    await query("INSERT INTO site_settings(key,value) VALUES ('maintenance_mode',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [enabled ? "on" : "off"]);
    res.json({ ok: true, enabled, message: enabled ? "Texniki işlər aktiv edildi" : "Texniki işlər dayandırıldı" });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Texniki işlər rejimini dəyişmək olmadı" });
  }
});

app.use(
  "/api",
  (req, res) => {
    res.status(404).json({
      ok: false,
      error:
        "API route not found",
      path: req.path
    });
  }
);

/* =========================================================
   FRONTEND — public maintenance gate (admins can still use site)
========================================================= */
app.use(async (req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api/") || req.path.startsWith("/assets/") || /\.(css|js|png|jpg|jpeg|webp|svg|ico|woff2?|mp3|mp4|webmanifest)$/i.test(req.path)) return next();
  try {
    const state = await query("SELECT value FROM site_settings WHERE key='maintenance_mode' LIMIT 1");
    const enabled = state.rows[0]?.value === "on";
    const admin = !!verifyAdminToken(getAdminToken(req));
    if (!enabled || admin) return next();
    res.status(503).type("html").send(`<!doctype html><html lang="az"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#72c894"><title>AliScore — Texniki işlər</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4faf6;color:#183b2a;font-family:Arial,sans-serif;padding:24px}.card{text-align:center;max-width:440px;background:white;padding:32px 24px;border-radius:24px;box-shadow:0 12px 40px #17482b14} .gear{font-size:56px}h1{font-size:25px;margin:12px 0}p{line-height:1.6;color:#587365}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#72c894;margin-right:7px}</style></head><body><main class="card"><div class="gear">🔧</div><h1>Texniki işlər aparılır</h1><p>AliScore hazırda yenilənir. Narahatlığa görə üzr istəyirik. Tezliklə geri qayıdacağıq!</p><p><span class="dot"></span>Sistem üzərində iş gedir</p></main></body></html>`);
  } catch (err) { next(); }
});

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);

app.use(
  (req, res, next) => {
    if (req.method !== "GET") {
      return next();
    }

    res.sendFile(
      path.join(
        __dirname,
        "public",
        "index.html"
      ),
      (err) => {
        if (err) {
          next(err);
        }
      }
    );
  }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (err, req, res, next) => {
    console.error(
      "Unhandled server error:",
      err
    );

    if (res.headersSent) {
      return next(err);
    }

    res.status(500).json({
      ok: false,
      error:
        err.message ||
        "Server error"
    });
  }
);

/* =========================================================
   START
========================================================= */

async function start() {
  try {
    await initDatabase();

    httpServer.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `AliScore server running on port ${PORT}`
        );
      }
    );
  } catch (err) {
    console.error(
      "SERVER START ERROR:",
      err
    );

    process.exit(1);
  }
}

start();
