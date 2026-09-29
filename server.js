const express = require("express");
const { Pool } = require("pg");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const path = require("path");
const crypto = require("crypto");
const webpush = require("web-push");

const app = express();

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
    red: "red_cards"
  };

  return map[type] || null;
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

async function sendPush(
  title,
  body,
  data = {}
) {
  if (!pushEnabled) {
    return;
  }

  let subscriptions;

  try {
    const result = await query(`
      SELECT
        id,
        endpoint,
        p256dh,
        auth
      FROM push_subscriptions
    `);

    subscriptions = result.rows;
  } catch (err) {
    console.error(
      "Push subscriptions read error:",
      err.message
    );

    return;
  }

  const payload = JSON.stringify({
    title,
    body,
    data
  });

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth
          }
        },
        payload
      );
    } catch (err) {
      console.error(
        "Push send error:",
        err.statusCode || "",
        err.message
      );

      if (
        err.statusCode === 404 ||
        err.statusCode === 410
      ) {
        try {
          await query(
            `
              DELETE FROM push_subscriptions
              WHERE id = $1
            `,
            [sub.id]
          );
        } catch (deleteErr) {
          console.error(
            "Old push subscription delete error:",
            deleteErr.message
          );
        }
      }
    }
  }
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

  await sendPush(
    title,
    body,
    data
  );
}

/* =========================================================
   DATABASE
========================================================= */

async function initDatabase() {
  await pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    avatar TEXT,
    favorite_team_id INTEGER,
    created_at TIMESTAMP DEFAULT NOW()
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
      own_goals INTEGER NOT NULL DEFAULT 0,
      rating NUMERIC DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  /* =======================================================
     GOAL OF THE WEEK VOTING
  ======================================================= */

  await query(`
    CREATE TABLE IF NOT EXISTS goal_of_week_polls (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'Həftənin qolu',
      week TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      closed_at TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS goal_of_week_candidates (
      id SERIAL PRIMARY KEY,
      poll_id INTEGER NOT NULL REFERENCES goal_of_week_polls(id) ON DELETE CASCADE,
      player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      match_id INTEGER REFERENCES matches(id) ON DELETE SET NULL,
      video_url TEXT NOT NULL DEFAULT '',
      description TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS goal_of_week_votes (
      id SERIAL PRIMARY KEY,
      poll_id INTEGER NOT NULL REFERENCES goal_of_week_polls(id) ON DELETE CASCADE,
      candidate_id INTEGER NOT NULL REFERENCES goal_of_week_candidates(id) ON DELETE CASCADE,
      voter_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (poll_id, voter_id)
    )
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
    ADD COLUMN IF NOT EXISTS own_goals INTEGER NOT NULL DEFAULT 0
  `);

  await query(`
    ALTER TABLE players
    ADD COLUMN IF NOT EXISTS rating NUMERIC DEFAULT 0
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
    ["Lotu pişiklər", "Ayxan", 2, "Müdafiəə"],
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

app.get("/api/health", async (req, res) => {
  try {
    await query("SELECT 1");

    res.json({
      ok: true,
      database: "connected"
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      database: "error",
      error: err.message
    });
  }
});

app.get("/api", async (req, res) => {
  try {
    await query("SELECT 1");

    res.json({
      ok: true,
      api: "AliScore API",
      database: "connected",
      push: pushEnabled
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      api: "AliScore API",
      database: "error",
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

function requireAdmin(req, res, next) {
  const token =
    getAdminToken(req);

  const decoded =
    verifyAdminToken(token);

  if (!decoded) {
    return res.status(401).json({
      ok: false,
      error: "Admin Login required",
      code: "ADMIN_REQUIRED"
    });
  }

  req.admin = decoded;
  req.adminToken = token;

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
                rating
              )
            VALUES
              ($1, $2, $3, $4, $5, $6)
            RETURNING *
          `,
          [
            teamId,
            name,
            number,
            position,
            photo
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
            rating = $11
          WHERE id = $12
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
        "red"
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

      let updatedMatch =
        match;

      if (type === "goal") {
        const homeIncrement =
          Number(teamId) ===
          Number(
            match.home_team_id
          )
            ? 1
            : 0;

        const awayIncrement =
          Number(teamId) ===
          Number(
            match.away_team_id
          )
            ? 1
            : 0;

        const scoreResult =
          await client.query(
            `
              UPDATE matches
              SET
                home_score =
                  home_score + $1,
                away_score =
                  away_score + $2
              WHERE id = $3
              RETURNING *
            `,
            [
              homeIncrement,
              awayIncrement,
              matchId
            ]
          );

        updatedMatch =
          scoreResult.rows[0];
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
        "red"
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

      /* Remove old goal */

      if (
        oldEvent.type === "goal"
      ) {
        const oldHome =
          Number(
            oldEvent.team_id
          ) ===
          Number(
            match.home_team_id
          )
            ? 1
            : 0;

        const oldAway =
          Number(
            oldEvent.team_id
          ) ===
          Number(
            match.away_team_id
          )
            ? 1
            : 0;

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

      /* Add new goal */

      if (type === "goal") {
        const homeAdd =
          Number(teamId) ===
          Number(
            match.home_team_id
          )
            ? 1
            : 0;

        const awayAdd =
          Number(teamId) ===
          Number(
            match.away_team_id
          )
            ? 1
            : 0;

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

      if (
        event.type === "goal"
      ) {
        const match =
          matchResult.rows[0];

        const home =
          Number(
            event.team_id
          ) ===
          Number(
            match.home_team_id
          )
            ? 1
            : 0;

        const away =
          Number(
            event.team_id
          ) ===
          Number(
            match.away_team_id
          )
            ? 1
            : 0;

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
        "saves"
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
          SET team_id = $1
          WHERE id = $2
        `,
        [
          toTeamId,
          playerId
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
                note
              )
            VALUES
              ($1, $2, $3, $4)
            RETURNING *
          `,
          [
            playerId,
            fromTeamId,
            toTeamId,
            note
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
   GOAL OF THE WEEK / HƏFTƏNİN QOLU
========================================================= */

function getVoterId(req, res) {
  let id = cleanString(req.cookies && req.cookies.aliscore_voter_id);
  if (!id || id.length < 20 || id.length > 100) {
    id = crypto.randomUUID();
    res.cookie("aliscore_voter_id", id, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 365 * 2
    });
  }
  return id;
}

app.get("/api/goal-of-week", async (req, res) => {
  try {
    const pollResult = await query(`
      SELECT id, title, week, status, created_at, closed_at
      FROM goal_of_week_polls
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `);
    if (!pollResult.rows.length) return res.json({ ok: true, poll: null, candidates: [], totalVotes: 0, winner: null });

    const poll = pollResult.rows[0];
    const result = await query(`
      SELECT
        c.id,
        c.poll_id,
        c.player_id,
        p.name AS player_name,
        p.photo AS player_photo,
        p.number AS player_number,
        p.team_id,
        t.name AS team_name,
        c.match_id,
        m.home_team_id,
        ht.name AS home_team_name,
        m.away_team_id,
        at.name AS away_team_name,
        m.home_score,
        m.away_score,
        m.match_date,
        c.video_url,
        c.description,
        c.created_at,
        COUNT(v.id)::int AS votes
      FROM goal_of_week_candidates c
      LEFT JOIN players p ON p.id = c.player_id
      LEFT JOIN teams t ON t.id = p.team_id
      LEFT JOIN matches m ON m.id = c.match_id
      LEFT JOIN teams ht ON ht.id = m.home_team_id
      LEFT JOIN teams at ON at.id = m.away_team_id
      LEFT JOIN goal_of_week_votes v ON v.candidate_id = c.id
      WHERE c.poll_id = $1
      GROUP BY c.id, p.id, t.id, m.id, ht.id, at.id
      ORDER BY votes DESC, c.id ASC
    `, [poll.id]);

    const totalVotes = result.rows.reduce((n, x) => n + Number(x.votes || 0), 0);
    const candidates = result.rows.map(x => ({
      ...x,
      votes: Number(x.votes || 0),
      percentage: totalVotes ? Math.round((Number(x.votes || 0) / totalVotes) * 1000) / 10 : 0
    }));
    const winner = poll.status === "closed" && candidates.length ? candidates[0] : null;

    res.json({ ok: true, poll, candidates, totalVotes, winner });
  } catch (err) {
    console.error("GET GOAL OF WEEK ERROR:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/goal-of-week/vote", async (req, res) => {
  const candidateId = nullableInt(req.body && (req.body.candidate_id ?? req.body.candidateId));
  if (!candidateId) return res.status(400).json({ ok: false, error: "Qol seçilməyib" });
  const voterId = getVoterId(req, res);
  try {
    const candidate = await query(`
      SELECT c.id, c.poll_id, p.status
      FROM goal_of_week_candidates c
      JOIN goal_of_week_polls p ON p.id = c.poll_id
      WHERE c.id = $1
    `, [candidateId]);
    if (!candidate.rows.length) return res.status(404).json({ ok: false, error: "Qol tapılmadı" });
    if (candidate.rows[0].status !== "open") return res.status(400).json({ ok: false, error: "Səsvermə bağlıdır" });

    await query(`
      INSERT INTO goal_of_week_votes (poll_id, candidate_id, voter_id)
      VALUES ($1, $2, $3)
    `, [candidate.rows[0].poll_id, candidateId, voterId]);

    res.json({ ok: true });
  } catch (err) {
    if (String(err.message || "").toLowerCase().includes("unique")) {
      return res.status(409).json({ ok: false, error: "Siz artıq bu həftə səs vermisiniz" });
    }
    console.error("GOAL VOTE ERROR:", err);
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/admin/goal-of-week/poll", requireAdmin, async (req, res) => {
  try {
    const title = cleanString(req.body && req.body.title) || "Həftənin qolu";
    const week = cleanString(req.body && req.body.week) || new Date().toISOString().slice(0, 10);
    const old = await query(`UPDATE goal_of_week_polls SET status='closed', closed_at=CURRENT_TIMESTAMP WHERE status='open'`);
    const result = await query(`
      INSERT INTO goal_of_week_polls (title, week, status)
      VALUES ($1, $2, 'open')
      RETURNING id, title, week, status, created_at
    `, [title, week]);
    res.json({ ok: true, poll: result.rows[0] });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/admin/goal-of-week/candidate", requireAdmin, async (req, res) => {
  try {
    const poll = await query(`SELECT id FROM goal_of_week_polls WHERE status='open' ORDER BY id DESC LIMIT 1`);
    if (!poll.rows.length) return res.status(400).json({ ok: false, error: "Əvvəlcə səsvermə yaradın" });
    const playerId = nullableInt(req.body && (req.body.player_id ?? req.body.playerId));
    const matchId = nullableInt(req.body && (req.body.match_id ?? req.body.matchId));
    const videoUrl = cleanString(req.body && (req.body.video_url ?? req.body.videoUrl));
    const description = cleanString(req.body && req.body.description);
    if (!playerId || !videoUrl) return res.status(400).json({ ok: false, error: "Oyunçu və video linki tələb olunur" });
    const result = await query(`
      INSERT INTO goal_of_week_candidates (poll_id, player_id, match_id, video_url, description)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [poll.rows[0].id, playerId, matchId, videoUrl, description]);
    res.json({ ok: true, candidate: result.rows[0] });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/admin/goal-of-week/close", requireAdmin, async (req, res) => {
  try {
    const result = await query(`
      UPDATE goal_of_week_polls
      SET status='closed', closed_at=CURRENT_TIMESTAMP
      WHERE id = COALESCE($1, (SELECT id FROM goal_of_week_polls ORDER BY id DESC LIMIT 1))
      RETURNING id, title, week, status, closed_at
    `, [nullableInt(req.body && (req.body.poll_id ?? req.body.pollId))]);
    if (!result.rows.length) return res.status(404).json({ ok: false, error: "Səsvermə tapılmadı" });
    await notify('goal-of-week', '⚽ Həftənin qolu', 'Həftənin qolu seçildi!', { pollId: result.rows[0].id });
    res.json({ ok: true, poll: result.rows[0] });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete("/api/admin/goal-of-week/candidate/:id", requireAdmin, async (req, res) => {
  try {
    await query(`DELETE FROM goal_of_week_candidates WHERE id=$1`, [intValue(req.params.id)]);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

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
   PUSH
========================================================= */

app.get(
  "/api/push/public-key",
  (req, res) => {
    res.json({
      ok: true,
      enabled:
        pushEnabled,
      publicKey:
        VAPID_PUBLIC_KEY ||
        null
    });
  }
);

app.post(
  "/api/push/subscribe",
  async (req, res) => {
    try {
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
      await sendPush(
        "AliScore",
        "Push bildirişləri işləyir! ⚽",
        {
          test: true
        }
      );

      res.json({
        ok: true,
        pushEnabled
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
   SERVICE WORKER
========================================================= */

app.get(
  "/service-worker.js",
  (req, res) => {
    res.setHeader(
      "Content-Type",
      "application/javascript"
    );

    res.setHeader(
      "Cache-Control",
      "no-cache, no-store, must-revalidate"
    );

    res.send(`
      self.addEventListener(
        "install",
        function(event) {
          self.skipWaiting();
        }
      );

      self.addEventListener(
        "activate",
        function(event) {
          event.waitUntil(
            self.clients.claim()
          );
        }
      );

      self.addEventListener(
        "push",
        function(event) {
          let data = {};

          try {
            data = event.data
              ? event.data.json()
              : {};
          } catch (e) {
            data = {
              title: "AliScore",
              body: event.data
                ? event.data.text()
                : ""
            };
          }

          const title =
            data.title ||
            "AliScore";

          const options = {
            body:
              data.body ||
              "Yeni bildiriş",
            icon:
              "/icon-192.png",
            badge:
              "/icon-192.png",
            data:
              data.data || {},
            vibrate:
              [200, 100, 200]
          };

          event.waitUntil(
            self.registration
              .showNotification(
                title,
                options
              )
          );
        }
      );

      self.addEventListener(
        "notificationclick",
        function(event) {
          event.notification.close();

          event.waitUntil(
            clients
              .matchAll({
                type: "window",
                includeUncontrolled: true
              })
              .then(function(clientList) {
                for (
                  const client of
                    clientList
                ) {
                  if (
                    "focus" in client
                  ) {
                    return client.focus();
                  }
                }

                if (
                  clients.openWindow
                ) {
                  return clients.openWindow(
                    "/"
                  );
                }
              })
          );
        }
      );
    `);
  }
);

/* =========================================================
   ALISCORE AI — LOCAL / FREE
========================================================= */

const ALISCORE_RATING_POINTS = {
  goals: 3,
  assists: 2,
  saves: 1,
  own_goals: -3,
  yellow_cards: -2,
  red_cards: -4
};

function ratingDeltaForStat(stat, delta) {
  const points = ALISCORE_RATING_POINTS[stat];
  if (!Number.isFinite(points)) return 0;
  return Number(delta) * points;
}

/* =========================================================
   ALISCORE AI — LOCAL / FREE
   No external AI API is required. The admin-only assistant
   understands common AliScore commands and reads PostgreSQL directly.
========================================================= */

function normalizeAIText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[əƏ]/g, "e")
    .replace(/[ıİ]/g, "i")
    .replace(/[şŞ]/g, "s")
    .replace(/[çÇ]/g, "c")
    .replace(/[ğĞ]/g, "g")
    .replace(/[öÖ]/g, "o")
    .replace(/[üÜ]/g, "u")
    .replace(/[’'`]/g, "")
    .replace(/[^a-z0-9а-яё\s+#-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAIStat(stat) {
  const s = normalizeAIText(stat).replace(/[_-]/g, " ");
  const map = {
    goal: "goals", goals: "goals", qol: "goals", qollar: "goals", qolun: "goals", gol: "goals", goller: "goals", goller: "goals",
    assist: "assists", assists: "assists", assistler: "assists", assisti: "assists", asisst: "assists",
    save: "saves", saves: "saves", seyv: "saves", seyvs: "saves", seyvler: "saves", seyvleri: "saves", seyvlər: "saves",
    own: "own_goals", owngoal: "own_goals", own_goals: "own_goals", autogol: "own_goals", autogoal: "own_goals", avtoqol: "own_goals", avtoqol: "own_goals",
    yellow: "yellow_cards", yellowcard: "yellow_cards", sari: "yellow_cards", sarikart: "yellow_cards", "sari kart": "yellow_cards", yellowcards: "yellow_cards",
    red: "red_cards", redcard: "red_cards", qirmizi: "red_cards", qirmizikart: "red_cards", redcards: "red_cards"
  };
  return map[s] || null;
}

function aiStatLabel(stat) {
  return ({
    goals: "⚽ Qol",
    assists: "🅰️ Assist",
    saves: "🧤 Seyv",
    own_goals: "🔄 Avtoqol",
    yellow_cards: "🟨 Sarı kart",
    red_cards: "🟥 Qırmızı kart"
  })[stat] || stat;
}

function aiRatingText(n) {
  const x = Number(n) || 0;
  return Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function aiFindPlayersInText(text, rows) {
  const ntext = normalizeAIText(text);
  const found = [];
  for (const p of rows) {
    const name = normalizeAIText(p.name);
    if (!name || name.length < 2) continue;
    if (ntext.includes(name)) found.push(p);
  }
  return found;
}

function aiExtractQuantity(text, stat, fallback = 1) {
  const n = normalizeAIText(text);
  const aliases = {
    goals: "(?:gol|goller|qol|qollar)",
    assists: "(?:assist|assistler|asisst)",
    saves: "(?:seyv|seyvler|save|saves)",
    own_goals: "(?:autogol|avtoqol|avtoqol|own\\s*goal)",
    yellow_cards: "(?:sari\\s*kart|sari|yellow\\s*card|yellow)",
    red_cards: "(?:qirmizi\\s*kart|qirmizi|red\\s*card|red)"
  };
  const a = aliases[stat];
  if (!a) return fallback;
  const re1 = new RegExp("(?:^|\\s)(\\d+)\\s*" + a + "(?:\\s|$)", "i");
  const re2 = new RegExp(a + "\\s*(\\d+)", "i");
  const m = n.match(re1) || n.match(re2);
  return m ? Math.max(1, Number(m[1] || m[2])) : fallback;
}

function aiHasDecrease(text, stat) {
  const n = normalizeAIText(text);
  const patterns = [
    "azalt", "azalts", "azald", "cix", "cixar", "cixart", "sil", "silinsin", "minus", "minusla",
    "ubav", "ubrat", "убав", "убери", "минус", "вычти", "сними", "удали", "уменьши", "убавь",
    "remove", "subtract", "decrease", "minus"
  ];
  return patterns.some(x => n.includes(x));
}

function aiLooksLikeAction(text) {
  const n = normalizeAIText(text);
  return /(?:elave|artir|artir|ver|vurdu|zab||добав|прибав|увелич|заб|сделал|сделай|убав|убери|вычти|удали|уменьш|сними|remove|subtract|decrease|set|qoy|qoymaq)/i.test(n) ||
    /(?:\\+|-)\\s*\\d+/.test(n) ||
    /(?:gol|qol|assist|seyv|autogol|avtoqol|sari|qirmizi|rating|reytinq)/i.test(n);
}

async function getLocalAIContext() {
  const players = await query(`
    SELECT p.id, p.name, p.position, p.number, p.goals, p.assists, p.saves,
           p.yellow_cards, p.red_cards, p.own_goals, p.rating,
           t.name AS team_name
    FROM players p
    LEFT JOIN teams t ON t.id = p.team_id
    ORDER BY p.name ASC
  `);

  const teams = await query(`
    SELECT id, name, points, played, wins, draws, losses, goals_for, goals_against,
           (goals_for - goals_against) AS goal_difference
    FROM teams
    ORDER BY points DESC, goal_difference DESC, goals_for DESC, name ASC
  `);

  const matches = await query(`
    SELECT m.id, m.home_score, m.away_score, m.status, m.match_date,
           ht.name AS home_team, at.name AS away_team
    FROM matches m
    LEFT JOIN teams ht ON ht.id = m.home_team_id
    LEFT JOIN teams at ON at.id = m.away_team_id
    ORDER BY m.match_date DESC, m.id DESC
    LIMIT 15
  `);

  return { players: players.rows, teams: teams.rows, matches: matches.rows };
}

function aiPlayerStatsLine(p) {
  return `${p.name} — ${p.team_name || "Klubsuz"}\n⚽ ${Number(p.goals)||0} · 🅰️ ${Number(p.assists)||0} · 🧤 ${Number(p.saves)||0} · 🔄 ${Number(p.own_goals)||0} · 🟨 ${Number(p.yellow_cards)||0} · 🟥 ${Number(p.red_cards)||0} · ⭐ ${aiRatingText(p.rating)}`;
}

function aiFindTeam(text, teams) {
  const n = normalizeAIText(text);
  return teams.find(t => n.includes(normalizeAIText(t.name))) || null;
}

function aiComparison(players) {
  if (players.length < 2) return null;
  const lines = players.slice(0, 4).map(p =>
    `**${p.name}** (${p.team_name || "Klubsuz"})\n⚽ ${Number(p.goals)||0} | 🅰️ ${Number(p.assists)||0} | 🧤 ${Number(p.saves)||0} | 🔄 ${Number(p.own_goals)||0} | 🟨 ${Number(p.yellow_cards)||0} | 🟥 ${Number(p.red_cards)||0} | ⭐ ${aiRatingText(p.rating)}`
  );
  return `📊 Müqayisə:\n\n${lines.join("\n\n")}`;
}

function aiQueryReply(message, ctx) {
  const n = normalizeAIText(message);
  const players = ctx.players;
  const teams = ctx.teams;
  const found = aiFindPlayersInText(message, players);

  if (found.length >= 2 && /(muqayise|mukayise|muqayis|compare|сравн|kim daha|hansi daha)/i.test(n)) {
    return aiComparison(found);
  }

  if (found.length === 1 && /(stat|statistika|gostəric|gosterici|nece|ne qeder|kimdir|kim|how many|сколько|статист|рейтинг|reytinq|rating)/i.test(n)) {
    return `📊 ${aiPlayerStatsLine(found[0])}`;
  }

  if (found.length === 1 && (n === normalizeAIText(found[0].name) || /(?:statistika|stats|profil|haqqinda|haqqında)/i.test(n))) {
    return `📊 ${aiPlayerStatsLine(found[0])}`;
  }

  const statQuestions = [
    ["goals", /(?:en cox|cox|lider|bombardir|gol kral|qol kral|top scorer|best scorer|больше всего|лучший бомбардир|бомбардир|голов)/i, "⚽ Ən çox qol"],
    ["assists", /(?:en cox|lider|assist|asist|больше всего.*ассист|ассист)/i, "🅰️ Ən çox assist"],
    ["saves", /(?:en cox|lider|seyv|save|больше всего.*сейв|сейв)/i, "🧤 Ən çox seyv"],
    ["rating", /(?:en yuksek|lider|best player|en yaxsi|ən yaxşı|рейтин|reytinq)/i, "⭐ Ən yüksək reytinq"]
  ];
  for (const [stat, rx, label] of statQuestions) {
    if (rx.test(n)) {
      const sorted = [...players].sort((a,b) => (Number(b[stat])||0) - (Number(a[stat])||0));
      const top = sorted.filter(p => (Number(p[stat])||0) > 0).slice(0,5);
      if (!top.length) return `${label}: hələ məlumat yoxdur.`;
      return `${label}:\n` + top.map((p,i) => `${i+1}. ${p.name} — ${Number(p[stat])||0}`).join("\n");
    }
  }

  if (/(xeyal komand|dream team|ideal heyet|ideal heyət|fantasy|команд.*мечт|dream)/i.test(n)) {
    const top = [...players].sort((a,b) => (Number(b.rating)||0) - (Number(a.rating)||0)).slice(0,11);
    return top.length ? `🌟 Xəyal komandası:\n${top.map((p,i)=>`${i+1}. ${p.name} — ${p.position || "Mövqe yoxdur"} — ⭐ ${aiRatingText(p.rating)}`).join("\n")}` : "Xəyal komandası üçün oyunçu yoxdur.";
  }

  const team = aiFindTeam(message, teams);
  if (team) {
    const teamPlayers = players.filter(p => Number(p.team_id) === Number(team.id));
    return `🏆 ${team.name}\nXal: ${Number(team.points)||0}\nMatç: ${Number(team.played)||0}\nQələbə: ${Number(team.wins)||0}\nHeç-heçə: ${Number(team.draws)||0}\nMəğlubiyyət: ${Number(team.losses)||0}\nQollar: ${Number(team.goals_for)||0}:${Number(team.goals_against)||0}\nOyunçular: ${teamPlayers.length}`;
  }

  if (/(son matc|son oyun|latest match|last match|последн.*матч)/i.test(n)) {
    const m = ctx.matches[0];
    if (!m) return "Hələ matç yoxdur.";
    return `⚽ Son matç: ${m.home_team || "?"} ${m.home_score ?? 0}:${m.away_score ?? 0} ${m.away_team || "?"}`;
  }

  if (/(qayda|reytinq sistemi|rating system|puan|nece hesablan|как считается|правил)/i.test(n)) {
    return "⭐ AliScore reytinq qaydaları:\n⚽ Qol +3\n🅰️ Assist +2\n🧤 Seyv +1\n🔄 Avtoqol −3\n🟨 Sarı kart −2\n🟥 Qırmızı kart −4";
  }

  return null;
}

function aiParseLocalActions(message, players) {
  const found = aiFindPlayersInText(message, players);
  if (!found.length) return { actions: [], error: null };
  if (found.length > 1 && /(elave|artir|azalt|cix|sil|добав|убав|удали|set|qoy|reytinq|rating)/i.test(normalizeAIText(message))) {
    return { actions: [], error: "Bir neçə oyunçu adı tapıldı. Dəqiq bir oyunçu adı yaz." };
  }

  const player = found[0];
  const n = normalizeAIText(message);
  const actions = [];

  // Real goal deletion: remove the match event itself, not only the player's goal statistic.
  const deleteGoalRequested =
    /(?:sil|silinsin|silmek|delete|remove|удали|удалить|убери|убрать|сними|снять|вычти|удал)/i.test(n) &&
    /(?:gol|qol|qolu|qolunu|goal|goals|гол|голы)/i.test(n);

  if (deleteGoalRequested) {
    let minute = null;
    const minuteMatch = n.match(/(?:dəqiqə|deqiqe|minute|min|минут(?:е|у)?|на\s+)?\s*(\d{1,3})\s*(?:'|\bdəq(?:iqə)?\b|\bmin(?:ute)?\b)?/i);
    if (minuteMatch) {
      const candidate = Number(minuteMatch[1]);
      if (candidate >= 0 && candidate <= 150) minute = candidate;
    }
    actions.push({ type: "delete_goal", player_name: player.name, minute });
    return { actions, error: null };
  }

  const ratingMatch = n.match(/(?:rating|reytinq|reytinqi|reytinqine|рейтин|рейтинг)\s*(?:ni|i|e|a|=)?\s*(?:qoy|et|set)?\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i) ||
    n.match(/(?:qoy|set)\s*(?:rating|reytinq)\s*(?:=|:)?\s*(-?\d+(?:\.\d+)?)/i);
  if (ratingMatch) {
    actions.push({ type: "set_rating", player_name: player.name, rating: Number(ratingMatch[1]) });
  }

  const statList = ["goals", "assists", "saves", "own_goals", "yellow_cards", "red_cards"];
  for (const stat of statList) {
    const aliases = {
      goals: "(?:gol|qol|goller|qollar)",
      assists: "(?:assist|assistler|asist)",
      saves: "(?:seyv|seyvler|save|saves)",
      own_goals: "(?:autogol|avtoqol|avtoqol|own\\s*goal)",
      yellow_cards: "(?:sari\\s*kart|sari|yellow\\s*card|yellow)",
      red_cards: "(?:qirmizi\\s*kart|qirmizi|red\\s*card|red)"
    }[stat];
    const re = new RegExp("(?:^|\\s)(\\d+)\\s*" + aliases + "|" + aliases + "\\s*(\\d+)", "i");
    const m = n.match(re);
    let qty = m ? Number(m[1] || m[2] || 1) : 0;
    if (!m && new RegExp(aliases, "i").test(n)) qty = 1;
    if (!qty) continue;
    if (!Number.isFinite(qty) || qty < 1) qty = 1;
    let windowText = n;
    const idx = m.index ?? 0;
    windowText = n.slice(Math.max(0, idx - 35), Math.min(n.length, idx + m[0].length + 35));
    let delta = qty;
    if (aiHasDecrease(windowText)) delta = -qty;
    if (new RegExp("(?:^|\\s)-\\s*" + qty + "\\s*" + aliases, "i").test(n)) delta = -qty;
    actions.push({ type: "change_stat", player_name: player.name, stat, delta });
  }

  return { actions, error: null };
}

async function resolveAIPlayer(name) {
  const target = normalizeAIText(name);
  if (!target) return { player: null, ambiguous: false };
  const result = await query(`
    SELECT p.*, t.name AS team_name
    FROM players p
    LEFT JOIN teams t ON t.id = p.team_id
    ORDER BY p.id ASC
  `);
  const exact = result.rows.filter(p => normalizeAIText(p.name) === target);
  if (exact.length === 1) return { player: exact[0], ambiguous: false };
  const partial = result.rows.filter(p => normalizeAIText(p.name).includes(target) || target.includes(normalizeAIText(p.name)));
  if (partial.length === 1) return { player: partial[0], ambiguous: false };
  return { player: null, ambiguous: partial.length > 1 };
}

function normalizeAIAction(action) {
  if (!action || typeof action !== "object") return null;
  const type = String(action.type || "").trim().toLowerCase();
  if (type === "change_stat") {
    const stat = normalizeAIStat(action.stat);
    const delta = Number(action.delta);
    if (!stat || !Number.isFinite(delta) || !Number.isInteger(delta) || delta === 0) return null;
    return { type: "change_stat", player_name: cleanString(action.player_name), stat, delta };
  }
  if (type === "set_rating") {
    const rating = Number(action.rating);
    if (!Number.isFinite(rating)) return null;
    return { type: "set_rating", player_name: cleanString(action.player_name), rating };
  }
  if (type === "delete_goal") {
    const playerName = cleanString(action.player_name);
    const goalId = Number(action.goal_id);
    const matchId = Number(action.match_id);
    const minute = action.minute === null || action.minute === undefined || action.minute === "" ? null : Number(action.minute);
    if (!playerName) return null;
    if (!Number.isInteger(goalId) || goalId <= 0) return null;
    if (!Number.isInteger(matchId) || matchId <= 0) return null;
    if (minute !== null && (!Number.isInteger(minute) || minute < 0 || minute > 150)) return null;
    return { type: "delete_goal", player_name: playerName, goal_id: goalId, match_id: matchId, minute };
  }
  return null;
}

function normalizeAIActions(value) {
  if (Array.isArray(value)) return value.map(normalizeAIAction).filter(Boolean).slice(0, 10);
  const one = normalizeAIAction(value);
  return one ? [one] : [];
}

async function applyAliScoreAIActions(actions) {
  const normalized = normalizeAIActions(actions);
  if (!normalized.length) throw new Error("AI əməliyyatı yoxdur.");
  const client = await pool.connect();
  const results = [];
  try {
    await client.query("BEGIN");
    for (const action of normalized) {
      const target = normalizeAIText(action.player_name);
      const lookup = await client.query(`
        SELECT p.*, t.name AS team_name
        FROM players p LEFT JOIN teams t ON t.id=p.team_id
        WHERE LOWER(p.name)=LOWER($1) OR LOWER(p.name) LIKE LOWER($2)
        ORDER BY p.id ASC
      `, [action.player_name, `%${target}%`]);
      if (lookup.rows.length !== 1) {
        throw new Error(lookup.rows.length > 1 ? `"${action.player_name}" adı bir neçə oyunçuya uyğun gəlir.` : `"${action.player_name}" adlı oyunçu tapılmadı.`);
      }
      const player = lookup.rows[0];

      if (action.type === "delete_goal") {
        const goal = await client.query(`
          SELECT e.*, m.home_team_id, m.away_team_id, m.home_score, m.away_score,
                 ht.name AS home_team_name, at.name AS away_team_name
          FROM match_events e
          JOIN matches m ON m.id = e.match_id
          LEFT JOIN teams ht ON ht.id = m.home_team_id
          LEFT JOIN teams at ON at.id = m.away_team_id
          WHERE e.id = $1
            AND e.match_id = $2
            AND e.player_id = $3
            AND e.type = 'goal'
          FOR UPDATE
        `, [action.goal_id, action.match_id, player.id]);

        if (!goal.rows.length) throw new Error("Qol hadisəsi tapılmadı və ya artıq silinib.");
        const g = goal.rows[0];

        const statResult = await client.query(`
          UPDATE players
          SET goals = GREATEST(COALESCE(goals,0)-1,0),
              rating = COALESCE(rating,0)-3
          WHERE id=$1
          RETURNING *
        `, [player.id]);

        const homeMinus = Number(g.team_id) === Number(g.home_team_id) ? 1 : 0;
        const awayMinus = Number(g.team_id) === Number(g.away_team_id) ? 1 : 0;
        await client.query(`
          UPDATE matches
          SET home_score=GREATEST(COALESCE(home_score,0)-$1,0),
              away_score=GREATEST(COALESCE(away_score,0)-$2,0)
          WHERE id=$3
        `, [homeMinus, awayMinus, g.match_id]);

        await client.query(`DELETE FROM match_events WHERE id=$1 AND match_id=$2`, [g.id, g.match_id]);
        const afterMatch = await client.query(`SELECT * FROM matches WHERE id=$1`, [g.match_id]);
        results.push({
          player: statResult.rows[0],
          rating_before: Number(player.rating)||0,
          rating_after: Number(statResult.rows[0].rating)||0,
          stat: "goals",
          delta: -1,
          deleted_goal: true,
          goal_id: g.id,
          match_id: g.match_id,
          minute: g.minute,
          match_label: `${g.home_team_name || "?"} ${g.home_score ?? 0}:${g.away_score ?? 0} ${g.away_team_name || "?"}`,
          match_after: afterMatch.rows[0]
        });
        continue;
      }

      if (action.type === "set_rating") {
        const result = await client.query(`UPDATE players SET rating=$1 WHERE id=$2 RETURNING *`, [action.rating, player.id]);
        results.push({ player: result.rows[0], rating_before: Number(player.rating)||0, rating_after: Number(result.rows[0].rating)||0, stat:null, delta:null });
      } else {
        const stat = action.stat;
        const delta = action.delta;
        const ratingDelta = ratingDeltaForStat(stat, delta);
        const result = await client.query(`
          UPDATE players
          SET ${stat}=GREATEST(COALESCE(${stat},0)+$1,0), rating=COALESCE(rating,0)+$2
          WHERE id=$3 RETURNING *
        `, [delta, ratingDelta, player.id]);
        results.push({ player: result.rows[0], rating_before: Number(player.rating)||0, rating_after: Number(result.rows[0].rating)||0, stat, delta });
      }
    }
    await client.query("COMMIT");
    return results;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally { client.release(); }
}

app.post("/api/ai/chat", requireAdmin, async (req, res) => {
  try {
    const message = cleanString(req.body.message);
    if (!message) return res.status(400).json({ ok:false, error:"Mesaj boşdur." });

    const ctx = await getLocalAIContext();
    const parsed = aiParseLocalActions(message, ctx.players);

    if (parsed.error) return res.json({ ok:true, reply:`⚠️ ${parsed.error}`, actions:[] });

    if (parsed.actions.length) {
      const actions = [];
      for (const raw of parsed.actions) {
        const action = normalizeAIAction(raw);
        if (!action) continue;
        const resolved = await resolveAIPlayer(action.player_name);
        if (resolved.ambiguous) return res.json({ ok:true, reply:`"${action.player_name}" üçün bir neçə oyunçu tapıldı. Dəqiq ad yaz.`, actions:[] });
        if (!resolved.player) return res.json({ ok:true, reply:`"${action.player_name}" adlı oyunçu tapılmadı.`, actions:[] });
        const current = resolved.player;
        if (action.type === "delete_goal") {
          const goalLookup = await query(`
            SELECT e.id, e.match_id, e.minute, e.team_id,
                   m.home_team_id, m.away_team_id,
                   m.home_score, m.away_score,
                   ht.name AS home_team_name, at.name AS away_team_name
            FROM match_events e
            JOIN matches m ON m.id=e.match_id
            LEFT JOIN teams ht ON ht.id=m.home_team_id
            LEFT JOIN teams at ON at.id=m.away_team_id
            WHERE e.player_id=$1 AND e.type='goal'
              AND ($2::int IS NULL OR e.minute=$2)
            ORDER BY e.id DESC
          `, [current.id, action.minute]);
          if (goalLookup.rows.length === 0) return res.json({ok:true, reply:`${current.name} üçün həmin qol tapılmadı.`, actions:[]});
          if (goalLookup.rows.length > 1) {
            const choices = goalLookup.rows.slice(0,10).map(g => `Matç #${g.match_id}: ${g.home_team_name||"?"} ${g.home_score??0}:${g.away_score??0} ${g.away_team_name||"?"} — ${g.minute ?? "?"}'`).join("\n");
            return res.json({ok:true, reply:`${current.name} üçün bir neçə qol tapıldı. Dəqiqəni yaz.\n${choices}`, actions:[]});
          }
          const g=goalLookup.rows[0];
          action.player_name=current.name;
          action.player_id=current.id;
          action.goal_id=g.id;
          action.match_id=g.match_id;
          action.minute=g.minute;
          action.match_label=`${g.home_team_name||"?"} ${g.home_score??0}:${g.away_score??0} ${g.away_team_name||"?"}`;
          action.rating_before=Number(current.rating)||0;
          action.rating_after=action.rating_before-3;
        } else if (action.type === "change_stat") {
          const currentStat = Number(current[action.stat]) || 0;
          const nextStat = Math.max(currentStat + action.delta, 0);
          const effectiveDelta = nextStat - currentStat;
          const ratingBefore = Number(current.rating) || 0;
          action.player_name = current.name;
          action.player_id = current.id;
          action.current_value = currentStat;
          action.next_value = nextStat;
          action.delta = effectiveDelta;
          action.rating_before = ratingBefore;
          action.rating_after = ratingBefore + ratingDeltaForStat(action.stat, effectiveDelta);
        } else {
          action.player_name = current.name;
          action.player_id = current.id;
          action.rating_before = Number(current.rating)||0;
          action.rating_after = Number(action.rating);
        }
        actions.push(action);
      }
      if (!actions.length) return res.json({ ok:true, reply:"Dəyişiklik əmri başa düşülmədi.", actions:[] });
      return res.json({ ok:true, reply:"Dəyişiklikləri yoxla və təsdiqlə:", actions });
    }

    const reply = aiQueryReply(message, ctx);
    if (reply) return res.json({ ok:true, reply, actions:[] });

    return res.json({
      ok:true,
      reply:"🤖 Mən AliScore-un pulsuz daxili AI köməkçisiyəm. Statistikaya baxa, oyunçuları müqayisə edə və dəyişiklikləri hazırlaya bilərəm. Məsələn: «Aliyə 2 qol əlavə et», «Ramilə 3 seyv əlavə et», «Ali statistikası», «ən çox qol kimdədir?». ",
      actions:[]
    });
  } catch (err) {
    console.error("AliScore local AI error:", err);
    res.status(400).json({ ok:false, error:err.message });
  }
});

app.post("/api/ai/confirm", requireAdmin, async (req, res) => {
  try {
    const actions = req.body.actions || req.body.action;
    const results = await applyAliScoreAIActions(actions);
    const messages = results.map(result => {
      const p = result.player;
      if (result.deleted_goal) return `🗑️ ${p.name}: qol silindi · ${result.match_label || `Matç #${result.match_id}`} · ${result.minute ?? "?"}' · ⚽ −1 · ⭐ ${aiRatingText(result.rating_before)} → ${aiRatingText(result.rating_after)}`;
      if (result.stat) return `✅ ${p.name}: ${aiStatLabel(result.stat)} ${result.delta > 0 ? "+" : ""}${result.delta}. ⭐ ${aiRatingText(result.rating_before)} → ${aiRatingText(result.rating_after)}`;
      return `✅ ${p.name}: ⭐ ${aiRatingText(result.rating_before)} → ${aiRatingText(result.rating_after)}`;
    });
    res.json({ ok:true, message:messages.join("\n"), players:results.map(x=>x.player) });
  } catch (err) {
    console.error("AliScore local AI confirm error:", err);
    res.status(400).json({ ok:false, error:err.message });
  }
});

/* =========================================================
   ALI AI COMMANDS
   Natural language commands for AliScore
   ========================================================= */

function aliNormalizeText(value) {
  return String(value || "")
    .toLocaleLowerCase("az-AZ")
    .replace(/[’'`]/g, "")
    .replace(/[‐-‒–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function aliNormalizeName(value) {
  return aliNormalizeText(value)
    .replace(/[-–—]/g, " ")
    .replace(/\b(nin|nın|nun|nün|in|ın|un|ün|nin|nın|nun|nün)\b/g, "")
    .replace(/\b(yə|ya|a|ə)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function aliCleanPlayerName(value) {
  return String(value || "")
    .trim()
    .replace(/^[,.:;!?]+/, "")
    .replace(/[,.:;!?]+$/, "")
    .replace(/^(?:oyuncu|player|oyunçu)\s+/iu, "")
    .trim();
}

function aliExtractMinute(text) {
  const s = aliNormalizeText(text);

  let m =
    s.match(/(\d{1,3})\s*(?:-?ci|-?cü|-?cu|-?cü|-?cı|-?cu)?\s*(?:dəqiqə|deqiqe|dəq|deq|minute|min)\b/i) ||
    s.match(/(?:at|on|na|в)\s*(\d{1,3})\s*(?:-?ci|-?cü|-?cu|-?cı)?\s*(?:dəqiqə|deqiqe|dəq|deq|minute|min|минут[аеы]?)?/i) ||
    s.match(/\b(\d{1,3})\s*(?:-ci|-cü|-cu|-cı)?\s*(?:minute|min|минут[аеы]?)\b/i);

  if (!m) return null;

  const minute = Number(m[1]);

  if (!Number.isInteger(minute) || minute < 0 || minute > 150) {
    return null;
  }

  return minute;
}

/*
  Converts different natural phrases into one action.

  Supported examples:

  Ali-nin qolunu sil
  Alinin qolunu sil
  Ali-nin 25-ci dəqiqədəki qolunu sil

  удали гол Али
  удали гол Али на 25 минуте

  delete Ali's goal
  delete Ali goal at 25 minute
*/

function parseAliCommand(input) {
  const original = String(input || "").trim();
  const text = aliNormalizeText(original);

  if (!text) {
    return {
      type: "unknown",
      original
    };
  }

  const minute = aliExtractMinute(text);

  /* =========================
     DELETE GOAL
     ========================= */

  const deleteGoal =
    /\b(qolunu|qolunu|qolun|qolu)\s+sil\b/i.test(text) ||
    /\b(qol)\s+sil\b/i.test(text) ||
    /\b(udali|удалить|удали|убери|убрать)\b.*\b(гол|qol|goal)\b/i.test(text) ||
    /\b(delete|remove)\b.*\b(goal|qol)\b/i.test(text) ||
    /\b(goal|qol)\b.*\b(delete|remove|sil)\b/i.test(text);

  if (deleteGoal) {
    let player = null;

    let m =
      original.match(/^(.+?)(?:-nin|-nın|-nun|-nün|-in|-ın|-un|-ün)?\s+qol(?:unu|un|u)?\s+sil/i) ||
      original.match(/^(.+?)\s+(?:qolunu|qolunu)\s+sil/i) ||
      original.match(/(?:удали|удалить|убери|убрать)\s+(?:гол)\s+(.+?)(?:\s+(?:на|в)\s+\d+)/i) ||
      original.match(/(?:delete|remove)\s+(?:the\s+)?goal\s+(?:of\s+)?(.+?)(?:\s+(?:at|on)\s+\d+)/i) ||
      original.match(/(?:delete|remove)\s+(.+?)\s+(?:goal)/i);

    if (m) {
      player = aliCleanPlayerName(m[1]);
    }

    /*
      Special Azerbaijani forms:
      Ali-nin qolunu sil
      Alinin qolunu sil
      Ali qolunu sil
    */
    if (!player) {
      let m2 = original.match(
        /^(.+?)(?:-nin|-nın|-nun|-nün|-in|-ın|-un|-ün)?\s+qol(?:unu|un|u)?\s+sil/i
      );

      if (m2) {
        player = aliCleanPlayerName(m2[1]);
      }
    }

    /*
      Remove minute words accidentally captured in player name.
    */
    if (player) {
      player = player
        .replace(/\s+(?:at|on|na|в)\s+\d+.*$/i, "")
        .replace(/\s+\d+\s*(?:-ci|-cü|-cu|-cı)?\s*(?:dəqiqə|deqiqe|dəq|deq|minute|min|минут.*)$/i, "")
        .trim();
    }

    return {
      type: "delete_goal",
      player_name: player || null,
      minute,
      original
    };
  }

  /* =========================
     ADD GOAL
     ========================= */

  const addGoal =
    /\b(qol\s+(?:əlavə et|ver|vur))\b/i.test(text) ||
    /\b(?:goal|qol)\s+(?:add|əlavə|vur)\b/i.test(text) ||
    /\b(?:add|əlavə et)\b.*\b(?:goal|qol)\b/i.test(text) ||
    /\b(?:забей|добавь|добавить)\b.*\b(?:гол)\b/i.test(text);

  if (addGoal) {
    let player = null;

    let m =
      original.match(/^(.+?)(?:-yə|-ya|-yə|-a|-ə)?\s+qol(?:u)?\s+(?:əlavə et|ver|vur)/i) ||
      original.match(/(?:добавь|добавить|забей)\s+(?:гол)\s+(.+)/i) ||
      original.match(/(?:add)\s+(?:goal)\s+(?:for\s+)?(.+)/i);

    if (m) player = aliCleanPlayerName(m[1]);

    return {
      type: "add_goal",
      player_name: player || null,
      minute,
      original
    };
  }

  /* =========================
     DELETE ASSIST
     ========================= */

  const deleteAssist =
    /\b(assist(?:i|ini|in|ni)?|assist)\s+sil\b/i.test(text) ||
    /\b(assist)\b.*\b(delete|remove)\b/i.test(text) ||
    /\b(?:удали|удалить|убери)\b.*\bассист\b/i.test(text);

  if (deleteAssist) {
    let player = null;

    let m =
      original.match(/^(.+?)(?:-nin|-nın|-nun|-nün|-in|-ın|-un|-ün)?\s+assist(?:i|ini|in|ni)?\s+sil/i) ||
      original.match(/(?:удали|удалить|убери)\s+(?:ассист)\s+(.+)/i) ||
      original.match(/(?:delete|remove)\s+(?:assist)\s+(?:of\s+)?(.+)/i);

    if (m) player = aliCleanPlayerName(m[1]);

    return {
      type: "delete_assist",
      player_name: player || null,
      minute,
      original
    };
  }

  /* =========================
     ADD YELLOW CARD
     ========================= */

  const addYellow =
    /\b(?:sarı\s+kart|sari\s+kart)\s+(?:ver|əlavə et)\b/i.test(text) ||
    /\b(?:give|add)\b.*\b(?:yellow\s+card)\b/i.test(text) ||
    /\b(?:дай|добавь)\b.*\b(?:желтую|жёлтую)\s+карточку\b/i.test(text);

  if (addYellow) {
    let player = null;

    let m =
      original.match(/^(.+?)(?:-yə|-ya|-ə|-a)?\s+(?:sarı|sari)\s+kart\s+(?:ver|əlavə et)/i) ||
      original.match(/(?:give|add)\s+(?:a\s+)?yellow\s+card\s+(?:to\s+)?(.+)/i) ||
      original.match(/(?:дай|добавь)\s+(?:желтую|жёлтую)\s+карточку\s+(.+)/i);

    if (m) player = aliCleanPlayerName(m[1]);

    return {
      type: "add_yellow",
      player_name: player || null,
      minute,
      original
    };
  }

  /* =========================
     DELETE YELLOW CARD
     ========================= */

  const deleteYellow =
    /\b(?:sarı|sari)\s+kart(?:ı|i|ini|ını)?\s+sil\b/i.test(text) ||
    /\b(?:yellow\s+card)\b.*\b(?:delete|remove)\b/i.test(text) ||
    /\b(?:удали|удалить|убери)\b.*\b(?:желтую|жёлтую)\s+карточку\b/i.test(text);

  if (deleteYellow) {
    let player = null;

    let m =
      original.match(/^(.+?)(?:-nin|-nın|-nun|-nün|-in|-ın|-un|-ün)?\s+(?:sarı|sari)\s+kart(?:ı|i|ini|ını)?\s+sil/i) ||
      original.match(/(?:удали|удалить|убери)\s+(?:желтую|жёлтую)\s+карточку\s+(.+)/i) ||
      original.match(/(?:delete|remove)\s+(?:yellow\s+card)\s+(?:of\s+)?(.+)/i);

    if (m) player = aliCleanPlayerName(m[1]);

    return {
      type: "delete_yellow",
      player_name: player || null,
      minute,
      original
    };
  }

  /* =========================
     SET RATING
     ========================= */

  const ratingMatch =
    original.match(/(.+?)(?:-nin|-nın|-nun|-nün|-in|-ın|-un|-ün)?\s+(?:reytinqini|reytingini|ratingini)\s+(\d+)\s*(?:et|etmək|qoy|ver)/i) ||
    original.match(/(?:set|make|change)\s+(.+?)\s+(?:rating)\s+(?:to)\s+(\d+)/i) ||
    original.match(/(?:установи|поставь|измени)\s+(?:рейтинг)\s+(.+?)\s+(?:на)\s+(\d+)/i);

  if (ratingMatch) {
    return {
      type: "set_rating",
      player_name: aliCleanPlayerName(ratingMatch[1]),
      rating: Number(ratingMatch[2]),
      original
    };
  }

  /* =========================
     TRANSFER PLAYER
     ========================= */

  const transferMatch =
    original.match(/(.+?)\s+(?:-ni|-nı|-nu|-nü)?\s*(?:Xirdalan\s+United|Xirdalan\s+Wolves|Neweli\s+FK|MSN\s+FK|Lotu\s+pişiklər)\s*(?:-a|-ə|-ya|-yə)?\s+keçir/i) ||
    original.match(/(?:transfer|move)\s+(.+?)\s+(?:to)\s+(.+)/i);

  if (transferMatch) {
    return {
      type: "transfer_player",
      player_name: aliCleanPlayerName(transferMatch[1]),
      team_name: String(transferMatch[2] || "").trim(),
      original
    };
  }

  return {
    type: "unknown",
    original
  };
}


/* =========================================================
   PLAYER FINDER FOR ALI AI
   ========================================================= */

async function aliFindPlayerByName(playerName) {
  if (!playerName) return null;

  const wanted = aliNormalizeName(playerName);

  const result = await pool.query(`
    SELECT
      id,
      name,
      team_id,
      goals,
      assists,
      saves,
      yellow_cards,
      red_cards,
      rating
    FROM players
    ORDER BY id
  `);

  const players = result.rows || [];

  /*
    1. Exact normalized match
  */
  let player = players.find(p =>
    aliNormalizeName(p.name) === wanted
  );

  if (player) return player;

  /*
    2. Contains match
  */
  player = players.find(p => {
    const n = aliNormalizeName(p.name);
    return n.includes(wanted) || wanted.includes(n);
  });

  return player || null;
}


/* =========================================================
   FIND GOALS OF PLAYER
   ========================================================= */

async function aliFindPlayerGoals(playerId, minute = null) {
  let sql = `
    SELECT
      e.id,
      e.match_id,
      e.player_id,
      e.team_id,
      e.type,
      e.minute,
      p.name AS player_name
    FROM match_events e
    LEFT JOIN players p ON p.id = e.player_id
    WHERE e.type = 'goal'
      AND e.player_id = $1
  `;

  const params = [playerId];

  if (minute !== null && minute !== undefined) {
    sql += ` AND e.minute = $2`;
    params.push(minute);
  }

  sql += ` ORDER BY e.minute DESC NULLS LAST, e.id DESC`;

  const result = await pool.query(sql, params);

  return result.rows || [];
}


/* =========================================================
   DELETE REAL MATCH EVENT
   This mirrors AliScore's normal event deletion behavior.
   ========================================================= */

async function aliDeleteGoalEvent(matchId, eventId) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const matchResult = await client.query(
      `
      SELECT id, home_team_id, away_team_id, home_score, away_score
      FROM matches
      WHERE id = $1
      FOR UPDATE
      `,
      [matchId]
    );

    if (!matchResult.rows.length) {
      throw new Error("Matç tapılmadı.");
    }

    const match = matchResult.rows[0];

    const eventResult = await client.query(
      `
      SELECT *
      FROM match_events
      WHERE id = $1
        AND match_id = $2
        AND type = 'goal'
      FOR UPDATE
      `,
      [eventId, matchId]
    );

    if (!eventResult.rows.length) {
      throw new Error("Qol hadisəsi tapılmadı.");
    }

    const event = eventResult.rows[0];

    /*
      Decrease player's goal statistic.
    */
    if (event.player_id) {
      await client.query(
        `
        UPDATE players
        SET goals = GREATEST(COALESCE(goals, 0) - 1, 0)
        WHERE id = $1
        `,
        [event.player_id]
      );
    }

    /*
      Decrease score of the correct team.
    */
    if (Number(event.team_id) === Number(match.home_team_id)) {
      await client.query(
        `
        UPDATE matches
        SET home_score = GREATEST(COALESCE(home_score, 0) - 1, 0)
        WHERE id = $1
        `,
        [matchId]
      );
    } else if (Number(event.team_id) === Number(match.away_team_id)) {
      await client.query(
        `
        UPDATE matches
        SET away_score = GREATEST(COALESCE(away_score, 0) - 1, 0)
        WHERE id = $1
        `,
        [matchId]
      );
    }

    /*
      Delete actual event.
    */
    await client.query(
      `
      DELETE FROM match_events
      WHERE id = $1
        AND match_id = $2
      `,
      [eventId, matchId]
    );

    await client.query("COMMIT");

    return {
      ok: true,
      match_id: matchId,
      event_id: eventId
    };

  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}


/* =========================================================
   EXECUTE ALI AI COMMAND
   ========================================================= */

async function executeAliAICommand(commandText) {
  const action = parseAliCommand(commandText);

  if (action.type === "unknown") {
    return {
      ok: false,
      type: "unknown",
      message:
        "Ali AI bu əmri başa düşmədi. Məsələn: «Ali-nin qolunu sil»."
    };
  }


  /* =======================================================
     DELETE GOAL
     ======================================================= */

  if (action.type === "delete_goal") {

    if (!action.player_name) {
      return {
        ok: false,
        type: "delete_goal",
        message:
          "Qolunu silmək istədiyin oyunçunun adını yaz. Məsələn: Ali-nin qolunu sil."
      };
    }

    const player = await aliFindPlayerByName(action.player_name);

    if (!player) {
      return {
        ok: false,
        type: "delete_goal",
        message:
          `Oyunçu tapılmadı: ${action.player_name}`
      };
    }

    const goals = await aliFindPlayerGoals(
      player.id,
      action.minute
    );

    if (!goals.length) {
      return {
        ok: false,
        type: "delete_goal",
        message:
          action.minute !== null
            ? `${player.name} üçün ${action.minute}-cı dəqiqədə qol tapılmadı.`
            : `${player.name} üçün silinəcək qol tapılmadı.`
      };
    }

    /*
      If there are several goals and no minute was specified,
      don't randomly delete one.
    */
    if (goals.length > 1 && action.minute === null) {
      return {
        ok: false,
        type: "delete_goal",
        multiple: true,
        player: player.name,
        choices: goals.map(g => ({
          goal_id: g.id,
          match_id: g.match_id,
          minute: g.minute
        })),
        message:
          `${player.name} üçün ${goals.length} qol tapıldı. Hansını silmək istədiyini dəqiqəsi ilə yaz.`
      };
    }

    const goal = goals[0];

    await aliDeleteGoalEvent(
      goal.match_id,
      goal.id
    );

    return {
      ok: true,
      type: "delete_goal",
      player: player.name,
      goal_id: goal.id,
      match_id: goal.match_id,
      minute: goal.minute,
      message:
        `${player.name} adlı oyunçunun ${goal.minute ?? "?"}-ci dəqiqədəki qolu silindi.`
    };
  }


  /* =======================================================
     SET RATING
     ======================================================= */

  if (action.type === "set_rating") {

    if (!action.player_name) {
      return {
        ok: false,
        message: "Oyunçunun adını yaz."
      };
    }

    const player = await aliFindPlayerByName(action.player_name);

    if (!player) {
      return {
        ok: false,
        message: `Oyunçu tapılmadı: ${action.player_name}`
      };
    }

    const rating = Number(action.rating);

    if (!Number.isFinite(rating)) {
      return {
        ok: false,
        message: "Rating düzgün rəqəm deyil."
      };
    }

    await pool.query(
      `
      UPDATE players
      SET rating = $1
      WHERE id = $2
      `,
      [rating, player.id]
    );

    return {
      ok: true,
      type: "set_rating",
      player: player.name,
      rating,
      message:
        `${player.name} oyunçusunun reytinqi ${rating} edildi.`
    };
  }


  /*
    These commands are recognized now.
    Their database actions can be connected next to the
    existing AliScore event/transfer handlers.
  */

  if (action.type === "add_goal") {
    return {
      ok: false,
      type: "add_goal",
      player_name: action.player_name,
      minute: action.minute,
      message:
        "Qol əlavə etmə əmri tanındı. Mövcud matçı seçmək lazımdır."
    };
  }

  if (action.type === "delete_assist") {
    return {
      ok: false,
      type: "delete_assist",
      player_name: action.player_name,
      minute: action.minute,
      message:
        "Assist silmə əmri tanındı."
    };
  }

  if (action.type === "add_yellow") {
    return {
      ok: false,
      type: "add_yellow",
      player_name: action.player_name,
      minute: action.minute,
      message:
        "Sarı kart əmri tanındı."
    };
  }

  if (action.type === "delete_yellow") {
    return {
      ok: false,
      type: "delete_yellow",
      player_name: action.player_name,
      minute: action.minute,
      message:
        "Sarı kart silmə əmri tanındı."
    };
  }

  if (action.type === "transfer_player") {
    return {
      ok: false,
      type: "transfer_player",
      player_name: action.player_name,
      team_name: action.team_name,
      message:
        "Transfer əmri tanındı."
    };
  }

  return {
    ok: false,
    type: action.type,
    message: "Əmr tanındı, amma icra funksiyası hələ qoşulmayıb."
  };
}


/* =========================================================
   OPTIONAL TEST
   =========================================================

   Bunları server.js-ə əlavə etməyə ehtiyac yoxdur.
   Console-da test etmək üçün:

   parseAliCommand("Ali-nin qolunu sil")
   parseAliCommand("Ali-nin 25-ci dəqiqədəki qolunu sil")
   parseAliCommand("удали гол Али на 25 минуте")
   parseAliCommand("delete Ali goal at 25 minute")

   ========================================================= */

/* =========================================================
   FRONTEND
========================================================= */

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
   USER REGISTRATION
========================================================= */

function hashUserPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

app.post("/api/users/register", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!username || !email || !password) {
      return res.status(400).json({
        ok: false,
        error: "Заполните все поля"
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        ok: false,
        error: "Пароль минимум 6 символов"
      });
    }

    const exists = await pool.query(
      `SELECT id FROM users
       WHERE username = $1 OR email = $2
       LIMIT 1`,
      [username, email]
    );

    if (exists.rows.length > 0) {
      return res.status(409).json({
        ok: false,
        error: "Пользователь уже существует"
      });
    }

    const passwordHash = hashUserPassword(password);

    const result = await pool.query(
      `INSERT INTO users
       (username, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username, email, created_at`,
      [username, email, passwordHash]
    );

    res.json({
      ok: true,
      user: result.rows[0]
    });

  } catch (err) {
    console.error("USER REGISTER ERROR:", err);

    res.status(500).json({
      ok: false,
      error: "Ошибка регистрации"
    });
  }
});
app.post("/api/users/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const result = await pool.query(
      `SELECT * FROM users WHERE email = $1 LIMIT 1`,
      [email]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        ok: false,
        error: "Неверный email или пароль"
      });
    }

    const user = result.rows[0];
    const [salt, savedHash] = user.password_hash.split(":");

    const hash = crypto
      .scryptSync(password, salt, 64)
      .toString("hex");

    if (hash !== savedHash) {
      return res.status(401).json({
        ok: false,
        error: "Неверный email или пароль"
      });
    }

    const token = jwt.sign(
      {
        userId: user.id,
        username: user.username
      },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.cookie("aliscore_user", token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000
    });

    res.json({
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        email: user.email
      }
    });

  } catch (err) {
    console.error("USER LOGIN ERROR:", err);

    res.status(500).json({
      ok: false,
      error: "Ошибка входа"
    });
  }
});
app.get("/api/users/me", async (req, res) => {
  try {
    const token = req.cookies.aliscore_user;

    if (!token) {
      return res.json({
        ok: false,
        user: null
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET);

    const result = await pool.query(
      `SELECT id, username, email, avatar, favorite_team_id, created_at
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [decoded.userId]
    );

    if (!result.rows.length) {
      return res.json({
        ok: false,
        user: null
      });
    }

    res.json({
      ok: true,
      user: result.rows[0]
    });

  } catch (err) {
    res.json({
      ok: false,
      user: null
    });
  }
});


app.post("/api/users/logout", (req, res) => {
  res.clearCookie("aliscore_user");

  res.json({
    ok: true
  });
});
/* =========================================================
   START
========================================================= */

async function start() {
  try {
    await initDatabase();
// ===============================
// 👤 USER ACCOUNT SYSTEM
// ===============================

const bcrypt = require("bcryptjs");

// Создание таблицы пользователей
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(150) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log("✅ Users cədvəli hazırdır");
  } catch (err) {
    console.error("❌ Users cədvəli xətası:", err.message);
  }
})();

// Qeydiyyat
app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({
        error: "Bütün xanaları doldurun."
      });
    }

    if (username.length < 3) {
      return res.status(400).json({
        error: "İstifadəçi adı ən azı 3 simvol olmalıdır."
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: "Şifrə ən azı 6 simvol olmalıdır."
      });
    }

    const existing = await pool.query(
      "SELECT id FROM users WHERE LOWER(username)=LOWER($1) OR LOWER(email)=LOWER($2)",
      [username.trim(), email.trim()]
    );

    if (existing.rows.length) {
      return res.status(409).json({
        error: "Bu istifadəçi adı və ya email artıq istifadə olunur."
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username, email, created_at`,
      [username.trim(), email.trim().toLowerCase(), passwordHash]
    );

    const user = result.rows[0];

    req.session = req.session || {};
    
    return res.json({
      ok: true,
      message: "Qeydiyyat uğurla tamamlandı.",
      user
    });

  } catch (err) {
    console.error("REGISTER ERROR:", err);
    return res.status(500).json({
      error: "Qeydiyyat zamanı server xətası baş verdi."
    });
  }
});

// Giriş
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: "Email və şifrəni daxil edin."
      });
    }

    const result = await pool.query(
      "SELECT * FROM users WHERE LOWER(email)=LOWER($1)",
      [email.trim().toLowerCase()]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        error: "Email və ya şifrə yanlışdır."
      });
    }

    const user = result.rows[0];

    const validPassword = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!validPassword) {
      return res.status(401).json({
        error: "Email və ya şifrə yanlışdır."
      });
    }

    // Sadə JWT istifadə edirik
    const token = jwt.sign(
      {
        userId: user.id,
        username: user.username,
        email: user.email
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "30d"
      }
    );

    res.cookie("aliscore_user", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000
    });

    return res.json({
      ok: true,
      message: "Uğurla daxil oldunuz.",
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        created_at: user.created_at
      }
    });

  } catch (err) {
    console.error("LOGIN ERROR:", err);
    return res.status(500).json({
      error: "Giriş zamanı server xətası baş verdi."
    });
  }
});

// Hazırkı istifadəçini yoxla
app.get("/api/auth/me", async (req, res) => {
  try {
    const token = req.cookies?.aliscore_user;

    if (!token) {
      return res.json({
        loggedIn: false
      });
    }

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    const result = await pool.query(
      "SELECT id, username, email, created_at FROM users WHERE id=$1",
      [decoded.userId]
    );

    if (!result.rows.length) {
      return res.json({
        loggedIn: false
      });
    }

    return res.json({
      loggedIn: true,
      user: result.rows[0]
    });

  } catch (err) {
    return res.json({
      loggedIn: false
    });
  }
});

// Çıxış
app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("aliscore_user");

  return res.json({
    ok: true,
    message: "Hesabdan çıxış edildi."
  });
});
    app.listen(
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
