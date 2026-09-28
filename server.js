const express = require("express");
const { Pool } = require("pg");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const path = require("path");
const webpush = require("web-push");


if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_EMAIL) {
  webpush.setVapidDetails(
    VAPID_EMAIL,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}
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

  // Compatibility migration for existing databases
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

  await seedData();
}
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

app.get("/api/health", async (req, res) => {
  try {
    let database = false;

    try {
      await pool.query("SELECT 1");
      database = true;
    } catch (dbErr) {
      database = false;
    }

    const pushConfigured = !!(
      VAPID_PUBLIC_KEY &&
      VAPID_PRIVATE_KEY &&
      VAPID_EMAIL
    );

    let subscriptions = 0;

    if (database) {
      try {
        const result = await pool.query(
          "SELECT COUNT(*)::int AS count FROM push_subscriptions"
        );

        subscriptions = result.rows[0]?.count || 0;
      } catch (pushErr) {
        subscriptions = 0;
      }
    }

    res.json({
      ok: true,
      server: true,
      database,
      push: {
        configured: pushConfigured,
        subscriptions
      },
      time: new Date().toISOString()
    });
  } catch (err) {
    console.error("HEALTH ERROR:", err);

    res.status(500).json({
      ok: false,
      server: true,
      error: "Health check failed"
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

    await pool.query(
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

    const updated = await pool.query(
      `SELECT * FROM teams WHERE id = $1`,
      [id]
    );

    res.json(updated.rows[0]);
  } catch (err) {
    console.error("UPDATE TEAM ERROR:", err);
    res.status(500).json({
      error: "Ошибка обновления команды"
    });
  }
});
app.delete("/api/teams/:id", admin, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).json({
        error: "Неверный ID команды"
      });
    }

    const result = await pool.query(
      `DELETE FROM teams WHERE id = $1 RETURNING *`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Команда не найдена"
      });
    }

    res.json({
      ok: true,
      team: result.rows[0]
    });
  } catch (err) {
    console.error("DELETE TEAM ERROR:", err);
    res.status(500).json({
      error: "Ошибка удаления команды"
    });
  }
});

/* =========================
   PLAYERS
========================= */

app.get("/api/players", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.*,
        t.name AS team_name,
        t.logo AS team_logo
      FROM players p
      LEFT JOIN teams t ON t.id = p.team_id
      ORDER BY p.name ASC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("GET PLAYERS ERROR:", err);
    res.status(500).json({
      error: "Ошибка загрузки игроков"
    });
  }
});
app.post("/api/players", admin, async (req, res) => {
  try {
    const name = cleanString(req.body.name);
    const teamId = intValue(req.body.team_id);
    const number = intValue(req.body.number);
    const position = cleanString(req.body.position);
    const photo = cleanString(req.body.photo);

    const goals = intValue(req.body.goals);
    const assists = intValue(req.body.assists);
    const saves = intValue(req.body.saves);
    const yellowCards = intValue(req.body.yellow_cards);
    const redCards = intValue(req.body.red_cards);
    const ownGoals = intValue(req.body.own_goals);

    const rating =
      req.body.rating !== undefined
        ? Number(req.body.rating)
        : 0;

    if (!name) {
      return res.status(400).json({
        error: "Введите имя игрока"
      });
    }

    if (!teamId) {
      return res.status(400).json({
        error: "Выберите команду"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO players (
        name,
        team_id,
        number,
        position,
        photo,
        goals,
        assists,
        saves,
        yellow_cards,
        red_cards,
        own_goals,
        rating
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
      )
      RETURNING *
      `,
      [
        name,
        teamId,
        number,
        position,
        photo,
        goals,
        assists,
        saves,
        yellowCards,
        redCards,
        ownGoals,
        rating
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("CREATE PLAYER ERROR:", err);
    res.status(500).json({
      error: "Ошибка добавления игрока"
    });
  }
});

app.put("/api/players/:id", admin, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).json({
        error: "Неверный ID игрока"
      });
    }

    const oldResult = await pool.query(
      `SELECT * FROM players WHERE id = $1`,
      [id]
    );

    if (!oldResult.rows.length) {
      return res.status(404).json({
        error: "Игрок не найден"
      });
    }

    const old = oldResult.rows[0];

    const name =
      req.body.name !== undefined
        ? cleanString(req.body.name)
        : old.name;

    const teamId =
      req.body.team_id !== undefined
        ? intValue(req.body.team_id)
        : old.team_id;

    const number =
      req.body.number !== undefined
        ? intValue(req.body.number)
        : old.number;

    const position =
      req.body.position !== undefined
        ? cleanString(req.body.position)
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

    const rating =
      req.body.rating !== undefined
        ? Number(req.body.rating)
        : old.rating;

    await pool.query(
      `
      UPDATE players
      SET
        name = $1,
        team_id = $2,
        number = $3,
        position = $4,
        photo = $5,
        goals = $6,
        assists = $7,
        saves = $8,
        yellow_cards = $9,
        red_cards = $10,
        own_goals = $11,
        rating = $12
      WHERE id = $13
      `,
      [
        name,
        teamId,
        number,
        position,
        photo,
        goals,
        assists,
        saves,
        yellowCards,
        redCards,
        ownGoals,
        rating,
        id
      ]
    );

    const updated = await pool.query(
      `SELECT * FROM players WHERE id = $1`,
      [id]
    );

    res.json(updated.rows[0]);
  } catch (err) {
    console.error("UPDATE PLAYER ERROR:", err);
    res.status(500).json({
      error: "Ошибка обновления игрока"
    });
  }
});
app.delete("/api/players/:id", admin, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).json({
        error: "Неверный ID игрока"
      });
    }

    const result = await pool.query(
      `DELETE FROM players WHERE id = $1 RETURNING *`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Игрок не найден"
      });
    }

    res.json({
      ok: true,
      player: result.rows[0]
    });
  } catch (err) {
    console.error("DELETE PLAYER ERROR:", err);
    res.status(500).json({
      error: "Ошибка удаления игрока"
    });
  }
});

/* =========================
   MATCHES
========================= */

app.get("/api/matches", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        m.*,
        ht.name AS home_team_name,
        ht.logo AS home_team_logo,
        at.name AS away_team_name,
        at.logo AS away_team_logo
      FROM matches m
      LEFT JOIN teams ht ON ht.id = m.home_team_id
      LEFT JOIN teams at ON at.id = m.away_team_id
      ORDER BY m.date DESC, m.id DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("GET MATCHES ERROR:", err);
    res.status(500).json({
      error: "Ошибка загрузки матчей"
    });
  }
});
app.post("/api/matches", admin, async (req, res) => {
  try {
    const homeTeamId = intValue(req.body.home_team_id);
    const awayTeamId = intValue(req.body.away_team_id);

    const homeScore =
      req.body.home_score !== undefined
        ? intValue(req.body.home_score)
        : 0;

    const awayScore =
      req.body.away_score !== undefined
        ? intValue(req.body.away_score)
        : 0;

    const date = cleanString(req.body.date);
    const status =
      cleanString(req.body.status) || "scheduled";

    if (!homeTeamId || !awayTeamId) {
      return res.status(400).json({
        error: "Выберите обе команды"
      });
    }

    if (homeTeamId === awayTeamId) {
      return res.status(400).json({
        error: "Команды должны быть разными"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO matches (
        home_team_id,
        away_team_id,
        home_score,
        away_score,
        date,
        status
      )
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *
      `,
      [
        homeTeamId,
        awayTeamId,
        homeScore,
        awayScore,
        date,
        status
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("CREATE MATCH ERROR:", err);
    res.status(500).json({
      error: "Ошибка создания матча"
    });
  }
});

app.put("/api/matches/:id", admin, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).json({
        error: "Неверный ID матча"
      });
    }

    const oldResult = await pool.query(
      `SELECT * FROM matches WHERE id = $1`,
      [id]
    );

    if (!oldResult.rows.length) {
      return res.status(404).json({
        error: "Матч не найден"
      });
    }

    const old = oldResult.rows[0];

    const homeTeamId =
      req.body.home_team_id !== undefined
        ? intValue(req.body.home_team_id)
        : old.home_team_id;

    const awayTeamId =
      req.body.away_team_id !== undefined
        ? intValue(req.body.away_team_id)
        : old.away_team_id;

    const homeScore =
      req.body.home_score !== undefined
        ? intValue(req.body.home_score)
        : old.home_score;

    const awayScore =
      req.body.away_score !== undefined
        ? intValue(req.body.away_score)
        : old.away_score;

    const date =
      req.body.date !== undefined
        ? cleanString(req.body.date)
        : old.date;

    const status =
      req.body.status !== undefined
        ? cleanString(req.body.status)
        : old.status;

    if (homeTeamId === awayTeamId) {
      return res.status(400).json({
        error: "Команды должны быть разными"
      });
    }

    const result = await pool.query(
      `
      UPDATE matches
      SET
        home_team_id = $1,
        away_team_id = $2,
        home_score = $3,
        away_score = $4,
        date = $5,
        status = $6
      WHERE id = $7
      RETURNING *
      `,
      [
        homeTeamId,
        awayTeamId,
        homeScore,
        awayScore,
        date,
        status,
        id
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("UPDATE MATCH ERROR:", err);
    res.status(500).json({
      error: "Ошибка обновления матча"
    });
  }
});
app.delete("/api/matches/:id", admin, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).json({
        error: "Неверный ID матча"
      });
    }

    await pool.query(
      `DELETE FROM match_events WHERE match_id = $1`,
      [id]
    );

    const result = await pool.query(
      `DELETE FROM matches WHERE id = $1 RETURNING *`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Матч не найден"
      });
    }

    res.json({
      ok: true,
      match: result.rows[0]
    });
  } catch (err) {
    console.error("DELETE MATCH ERROR:", err);
    res.status(500).json({
      error: "Ошибка удаления матча"
    });
  }
});

/* =========================
   MATCH EVENTS
========================= */

app.get("/api/matches/:id/events", async (req, res) => {
  try {
    const matchId = Number(req.params.id);

    if (!Number.isInteger(matchId)) {
      return res.status(400).json({
        error: "Неверный ID матча"
      });
    }

    const result = await pool.query(
      `
      SELECT
        e.*,
        p.name AS player_name,
        p.photo AS player_photo
      FROM match_events e
      LEFT JOIN players p ON p.id = e.player_id
      WHERE e.match_id = $1
      ORDER BY e.minute ASC, e.id ASC
      `,
      [matchId]
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET MATCH EVENTS ERROR:", err);
    res.status(500).json({
      error: "Ошибка загрузки событий"
    });
  }
});
app.post("/api/matches/:id/events", admin, async (req, res) => {
  try {
    const matchId = Number(req.params.id);

    if (!Number.isInteger(matchId)) {
      return res.status(400).json({
        error: "Неверный ID матча"
      });
    }

    const matchCheck = await pool.query(
      `SELECT * FROM matches WHERE id = $1`,
      [matchId]
    );

    if (!matchCheck.rows.length) {
      return res.status(404).json({
        error: "Матч не найден"
      });
    }

    const type = cleanString(req.body.type).toLowerCase();
    const playerId = intValue(req.body.player_id);
    const minute = intValue(req.body.minute);

    const allowedTypes = [
      "goal",
      "assist",
      "save",
      "yellow",
      "red",
      "own_goal"
    ];

    if (!allowedTypes.includes(type)) {
      return res.status(400).json({
        error: "Yanlış statistika"
      });
    }

    if (!playerId) {
      return res.status(400).json({
        error: "Игрок не выбран"
      });
    }

    const playerCheck = await pool.query(
      `SELECT * FROM players WHERE id = $1`,
      [playerId]
    );

    if (!playerCheck.rows.length) {
      return res.status(404).json({
        error: "Игрок не найден"
      });
    }

    const player = playerCheck.rows[0];

    const result = await pool.query(
      `
      INSERT INTO match_events (
        match_id,
        player_id,
        type,
        minute
      )
      VALUES ($1,$2,$3,$4)
      RETURNING *
      `,
      [
        matchId,
        playerId,
        type,
        minute
      ]
    );

    if (type === "goal") {
      await pool.query(
        `
        UPDATE players
        SET goals = COALESCE(goals, 0) + 1,
            rating = COALESCE(rating, 0) + 1
        WHERE id = $1
        `,
        [playerId]
      );
    }

    if (type === "assist") {
      await pool.query(
        `
        UPDATE players
        SET assists = COALESCE(assists, 0) + 1,
            rating = COALESCE(rating, 0) + 0.5
        WHERE id = $1
        `,
        [playerId]
      );
    }

    if (type === "save") {
      await pool.query(
        `
        UPDATE players
        SET saves = COALESCE(saves, 0) + 1,
            rating = COALESCE(rating, 0) + 0.5
        WHERE id = $1
        `,
        [playerId]
      );
    }

    if (type === "yellow") {
      await pool.query(
        `
        UPDATE players
        SET yellow_cards = COALESCE(yellow_cards, 0) + 1,
            rating = COALESCE(rating, 0) - 0.5
        WHERE id = $1
        `,
        [playerId]
      );
    }

    if (type === "red") {
      await pool.query(
        `
        UPDATE players
        SET red_cards = COALESCE(red_cards, 0) + 1,
            rating = COALESCE(rating, 0) - 1
        WHERE id = $1
        `,
        [playerId]
      );
    }

    if (type === "own_goal") {
      await pool.query(
        `
        UPDATE players
        SET own_goals = COALESCE(own_goals, 0) + 1
        WHERE id = $1
        `,
        [playerId]
      );
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("CREATE MATCH EVENT ERROR:", err);
    res.status(500).json({
      error: "Ошибка добавления события"
    });
  }
});
app.delete("/api/matches/:matchId/events/:eventId", admin, async (req, res) => {
  try {
    const matchId = Number(req.params.matchId);
    const eventId = Number(req.params.eventId);

    if (!Number.isInteger(matchId) || !Number.isInteger(eventId)) {
      return res.status(400).json({
        error: "Неверный ID"
      });
    }

    const eventResult = await pool.query(
      `
      SELECT *
      FROM match_events
      WHERE id = $1 AND match_id = $2
      `,
      [eventId, matchId]
    );

    if (!eventResult.rows.length) {
      return res.status(404).json({
        error: "Событие не найдено"
      });
    }

    const event = eventResult.rows[0];

    if (event.player_id) {
      if (event.type === "goal") {
        await pool.query(
          `
          UPDATE players
          SET
            goals = GREATEST(COALESCE(goals, 0) - 1, 0),
            rating = COALESCE(rating, 0) - 1
          WHERE id = $1
          `,
          [event.player_id]
        );
      }

      if (event.type === "assist") {
        await pool.query(
          `
          UPDATE players
          SET
            assists = GREATEST(COALESCE(assists, 0) - 1, 0),
            rating = COALESCE(rating, 0) - 0.5
          WHERE id = $1
          `,
          [event.player_id]
        );
      }

      if (event.type === "save") {
        await pool.query(
          `
          UPDATE players
          SET
            saves = GREATEST(COALESCE(saves, 0) - 1, 0),
            rating = COALESCE(rating, 0) - 0.5
          WHERE id = $1
          `,
          [event.player_id]
        );
      }

      if (event.type === "yellow") {
        await pool.query(
          `
          UPDATE players
          SET
            yellow_cards = GREATEST(COALESCE(yellow_cards, 0) - 1, 0),
            rating = COALESCE(rating, 0) + 0.5
          WHERE id = $1
          `,
          [event.player_id]
        );
      }

      if (event.type === "red") {
        await pool.query(
          `
          UPDATE players
          SET
            red_cards = GREATEST(COALESCE(red_cards, 0) - 1, 0),
            rating = COALESCE(rating, 0) + 1
          WHERE id = $1
          `,
          [event.player_id]
        );
      }

      if (event.type === "own_goal") {
        await pool.query(
          `
          UPDATE players
          SET
            own_goals = GREATEST(COALESCE(own_goals, 0) - 1)
          WHERE id = $1
          `,
          [event.player_id]
        );
      }
    }

    await pool.query(
      `DELETE FROM match_events WHERE id = $1`,
      [eventId]
    );

    res.json({
      ok: true,
      deleted: event
    });
  } catch (err) {
    console.error("DELETE MATCH EVENT ERROR:", err);
    res.status(500).json({
      error: "Ошибка удаления события"
    });
  }
});
app.put("/api/matches/:matchId/events/:eventId", admin, async (req, res) => {
  try {
    const matchId = Number(req.params.matchId);
    const eventId = Number(req.params.eventId);

    if (!Number.isInteger(matchId) || !Number.isInteger(eventId)) {
      return res.status(400).json({
        error: "Неверный ID"
      });
    }

    const oldResult = await pool.query(
      `
      SELECT *
      FROM match_events
      WHERE id = $1 AND match_id = $2
      `,
      [eventId, matchId]
    );

    if (!oldResult.rows.length) {
      return res.status(404).json({
        error: "Событие не найдено"
      });
    }

    const old = oldResult.rows[0];

    const type =
      req.body.type !== undefined
        ? cleanString(req.body.type).toLowerCase()
        : old.type;

    const playerId =
      req.body.player_id !== undefined
        ? intValue(req.body.player_id)
        : old.player_id;

    const minute =
      req.body.minute !== undefined
        ? intValue(req.body.minute)
        : old.minute;

    const allowedTypes = [
      "goal",
      "assist",
      "save",
      "yellow",
      "red",
      "own_goal"
    ];

    if (!allowedTypes.includes(type)) {
      return res.status(400).json({
        error: "Yanlış statistika"
      });
    }

    if (!playerId) {
      return res.status(400).json({
        error: "Игрок не выбран"
      });
    }

    const playerCheck = await pool.query(
      `SELECT id FROM players WHERE id = $1`,
      [playerId]
    );

    if (!playerCheck.rows.length) {
      return res.status(404).json({
        error: "Игрок не найден"
      });
    }

    await pool.query(
      `
      UPDATE match_events
      SET
        type = $1,
        player_id = $2,
        minute = $3
      WHERE id = $4 AND match_id = $5
      `,
      [
        type,
        playerId,
        minute,
        eventId,
        matchId
      ]
    );

    const updated = await pool.query(
      `
      SELECT *
      FROM match_events
      WHERE id = $1
      `,
      [eventId]
    );

    res.json(updated.rows[0]);
  } catch (err) {
    console.error("UPDATE MATCH EVENT ERROR:", err);
    res.status(500).json({
      error: "Ошибка изменения события"
    });
  }
});
/* =========================
   STATISTICS
========================= */

app.get("/api/statistics", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.id,
        p.name,
        p.photo,
        p.position,
        p.goals,
        p.assists,
        p.saves,
        p.yellow_cards,
        p.red_cards,
        p.own_goals,
        p.rating,
        t.name AS team_name,
        t.logo AS team_logo
      FROM players p
      LEFT JOIN teams t ON t.id = p.team_id
      ORDER BY
        COALESCE(p.rating, 0) DESC,
        COALESCE(p.goals, 0) DESC,
        p.name ASC
    `);

    res.json({
      players: result.rows,
      scorers: [...result.rows].sort(
        (a, b) => (b.goals || 0) - (a.goals || 0)
      ),
      assists: [...result.rows].sort(
        (a, b) => (b.assists || 0) - (a.assists || 0)
      ),
      saves: [...result.rows].sort(
        (a, b) => (b.saves || 0) - (a.saves || 0)
      ),
      yellowCards: [...result.rows].sort(
        (a, b) => (b.yellow_cards || 0) - (a.yellow_cards || 0)
      ),
      redCards: [...result.rows].sort(
        (a, b) => (b.red_cards || 0) - (a.red_cards || 0)
      ),
      ownGoals: [...result.rows].sort(
        (a, b) => (b.own_goals || 0) - (a.own_goals || 0)
      ),
      ratings: [...result.rows].sort(
        (a, b) => (b.rating || 0) - (a.rating || 0)
      )
    });
  } catch (err) {
    console.error("GET STATISTICS ERROR:", err);

    res.status(500).json({
      error: "Ошибка загрузки статистики"
    });
  }
});
/* =========================
   STANDINGS
========================= */

app.get("/api/standings", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        t.id,
        t.name,
        t.logo,
        t.captain,

        COALESCE(t.points, 0) AS points,
        COALESCE(t.played, 0) AS played,
        COALESCE(t.wins, 0) AS wins,
        COALESCE(t.draws, 0) AS draws,
        COALESCE(t.losses, 0) AS losses,
        COALESCE(t.goals_for, 0) AS goals_for,
        COALESCE(t.goals_against, 0) AS goals_against,

        (
          COALESCE(t.goals_for, 0) -
          COALESCE(t.goals_against, 0)
        ) AS goal_difference

      FROM teams t

      ORDER BY
        COALESCE(t.points, 0) DESC,
        (
          COALESCE(t.goals_for, 0) -
          COALESCE(t.goals_against, 0)
        ) DESC,
        COALESCE(t.goals_for, 0) DESC,
        t.name ASC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("GET STANDINGS ERROR:", err);

    res.status(500).json({
      error: "Ошибка загрузки турнирной таблицы"
    });
  }
});
/* =========================
   DREAM TEAM
========================= */

app.get("/api/team-of-week", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.id,
        p.name,
        p.photo,
        p.position,
        p.goals,
        p.assists,
        p.saves,
        p.yellow_cards,
        p.red_cards,
        p.own_goals,
        p.rating,
        t.name AS team_name,
        t.logo AS team_logo
      FROM players p
      LEFT JOIN teams t ON t.id = p.team_id
      ORDER BY
        COALESCE(p.rating, 0) DESC,
        COALESCE(p.goals, 0) DESC,
        COALESCE(p.assists, 0) DESC
      LIMIT 11
    `);

    res.json({
      name: "Xəyal komandası",
      players: result.rows
    });
  } catch (err) {
    console.error("DREAM TEAM ERROR:", err);

    res.status(500).json({
      error: "Ошибка загрузки Xəyal komandası"
    });
  }
});
/* =========================
   PLAYER OF THE MATCH
========================= */

app.put("/api/matches/:id/player-of-match", admin, async (req, res) => {
  try {
    const matchId = Number(req.params.id);
    const playerId = intValue(req.body.player_id);

    if (!Number.isInteger(matchId)) {
      return res.status(400).json({
        error: "Неверный ID матча"
      });
    }

    if (!playerId) {
      return res.status(400).json({
        error: "Игрок не выбран"
      });
    }

    const matchResult = await pool.query(
      `SELECT * FROM matches WHERE id = $1`,
      [matchId]
    );

    if (!matchResult.rows.length) {
      return res.status(404).json({
        error: "Матч не найден"
      });
    }

    const playerResult = await pool.query(
      `SELECT * FROM players WHERE id = $1`,
      [playerId]
    );

    if (!playerResult.rows.length) {
      return res.status(404).json({
        error: "Игрок не найден"
      });
    }

    await pool.query(
      `
      UPDATE matches
      SET player_of_match_id = $1
      WHERE id = $2
      `,
      [playerId, matchId]
    );

    const updated = await pool.query(
      `
      SELECT
        m.*,
        p.name AS player_of_match_name,
        p.photo AS player_of_match_photo
      FROM matches m
      LEFT JOIN players p
        ON p.id = m.player_of_match_id
      WHERE m.id = $1
      `,
      [matchId]
    );

    res.json(updated.rows[0]);
  } catch (err) {
    console.error("PLAYER OF MATCH ERROR:", err);

    res.status(500).json({
      error: "Ошибка назначения игрока матча"
    });
  }
});
/* =========================
   TRANSFERS
========================= */

app.get("/api/transfers", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        tr.*,
        p.name AS player_name,
        p.photo AS player_photo,
        ft.name AS from_team_name,
        ft.logo AS from_team_logo,
        tt.name AS to_team_name,
        tt.logo AS to_team_logo
      FROM transfers tr
      LEFT JOIN players p ON p.id = tr.player_id
      LEFT JOIN teams ft ON ft.id = tr.from_team_id
      LEFT JOIN teams tt ON tt.id = tr.to_team_id
      ORDER BY tr.id DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("GET TRANSFERS ERROR:", err);

    res.status(500).json({
      error: "Ошибка загрузки трансферов"
    });
  }
});

app.post("/api/transfers", admin, async (req, res) => {
  try {
    const playerId = intValue(req.body.player_id);
    const fromTeamId = intValue(req.body.from_team_id);
    const toTeamId = intValue(req.body.to_team_id);

    const fee =
      req.body.fee !== undefined
        ? Number(req.body.fee)
        : 0;

    if (!playerId || !fromTeamId || !toTeamId) {
      return res.status(400).json({
        error: "Заполните все поля трансфера"
      });
    }

    if (fromTeamId === toTeamId) {
      return res.status(400).json({
        error: "Команды должны быть разными"
      });
    }

    if (!Number.isFinite(fee) || fee < 0) {
      return res.status(400).json({
        error: "Неверная трансферная стоимость"
      });
    }

    const playerResult = await pool.query(
      `SELECT * FROM players WHERE id = $1`,
      [playerId]
    );

    if (!playerResult.rows.length) {
      return res.status(404).json({
        error: "Игрок не найден"
      });
    }

    const player = playerResult.rows[0];

    if (Number(player.team_id) !== fromTeamId) {
      return res.status(400).json({
        error: "Игрок не находится в выбранной команде"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO transfers (
        player_id,
        from_team_id,
        to_team_id,
        fee
      )
      VALUES ($1,$2,$3,$4)
      RETURNING *
      `,
      [
        playerId,
        fromTeamId,
        toTeamId,
        fee
      ]
    );

    await pool.query(
      `
      UPDATE players
      SET team_id = $1
      WHERE id = $2
      `,
      [toTeamId, playerId]
    );

    res.json({
      ok: true,
      transfer: result.rows[0]
    });
  } catch (err) {
    console.error("CREATE TRANSFER ERROR:", err);

    res.status(500).json({
      error: "Ошибка создания трансфера"
    });
  }
});
/* =========================
   PLAYER MARKET VALUE
========================= */

app.put("/api/players/:id/market-value", admin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const marketValue = Number(req.body.market_value);

    if (!Number.isInteger(id)) {
      return res.status(400).json({
        error: "Неверный ID игрока"
      });
    }

    if (!Number.isFinite(marketValue) || marketValue < 0) {
      return res.status(400).json({
        error: "Неверная трансферная стоимость"
      });
    }

    const playerResult = await pool.query(
      `SELECT * FROM players WHERE id = $1`,
      [id]
    );

    if (!playerResult.rows.length) {
      return res.status(404).json({
        error: "Игрок не найден"
      });
    }

    const result = await pool.query(
      `
      UPDATE players
      SET market_value = $1
      WHERE id = $2
      RETURNING *
      `,
      [marketValue, id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("MARKET VALUE ERROR:", err);

    res.status(500).json({
      error: "Ошибка изменения трансферной стоимости"
    });
  }
});
/* =========================
   PLAYER MARKET VALUE GET
========================= */

app.get("/api/players/:id/market-value", async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).json({
        error: "Неверный ID игрока"
      });
    }

    const result = await pool.query(
      `
      SELECT
        p.id,
        p.name,
        p.photo,
        p.position,
        p.rating,
        p.market_value,
        t.id AS team_id,
        t.name AS team_name,
        t.logo AS team_logo
      FROM players p
      LEFT JOIN teams t ON t.id = p.team_id
      WHERE p.id = $1
      `,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Игрок не найден"
      });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET MARKET VALUE ERROR:", err);

    res.status(500).json({
      error: "Ошибка получения трансферной стоимости"
    });
  }
});
/* =========================
   CARDS
========================= */

app.get("/api/cards", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.id,
        p.name,
        p.photo,
        p.yellow_cards,
        p.red_cards,
        t.name AS team_name,
        t.logo AS team_logo
      FROM players p
      LEFT JOIN teams t ON t.id = p.team_id
      WHERE
        COALESCE(p.yellow_cards, 0) > 0
        OR COALESCE(p.red_cards, 0) > 0
      ORDER BY
        COALESCE(p.red_cards, 0) DESC,
        COALESCE(p.yellow_cards, 0) DESC,
        p.name ASC
    `);

        const matchInfo = await pool.query(
      `
      SELECT
        m.*,
        ht.name AS home_team_name,
        at.name AS away_team_name,
        p.name AS player_name
      FROM matches m
      LEFT JOIN teams ht
        ON ht.id = m.home_team_id
      LEFT JOIN teams at
        ON at.id = m.away_team_id
      LEFT JOIN players p
        ON p.id = $2
      WHERE m.id = $1
      `,
      [matchId, playerId]
    );

    const match = matchInfo.rows[0];

    if (match) {
      let notificationTitle = "AliScore";
      let notificationMessage = "";

      if (type === "goal") {
        notificationTitle = "⚽ QOL!";
        notificationMessage =
          `${match.player_name} qol vurdu — ${match.home_team_name} ${match.home_score}:${match.away_score} ${match.away_team_name}`;
      }

      if (type === "own_goal") {
        notificationTitle = "⚽ Avtoqol!";
        notificationMessage =
          `${match.player_name} avtoqol etdi — ${match.home_team_name} ${match.home_score}:${match.away_score} ${match.away_team_name}`;
      }

      if (type === "assist") {
        notificationTitle = "🎯 Assist!";
        notificationMessage =
          `${match.player_name} assist etdi.`;
      }

      if (type === "save") {
        notificationTitle = "🧤 Seyv!";
        notificationMessage =
          `${match.player_name} vacib seyf etdi.`;
      }

      if (type === "yellow") {
        notificationTitle = "🟨 Sarı kart!";
        notificationMessage =
          `${match.player_name} sarı kart aldı.`;
      }

      if (type === "red") {
        notificationTitle = "🟥 Qırmızı kart!";
        notificationMessage =
          `${match.player_name} qırmızı kart aldı.`;
      }

      if (notificationMessage) {
        await createAndSendNotification(
          notificationTitle,
          notificationMessage,
          type,
          {
            match_id: matchId,
            player_id: playerId,
            minute
          }
        );
      }
    }

        const matchInfo = await pool.query(
      `
      SELECT
        m.*,
        ht.name AS home_team_name,
        at.name AS away_team_name,
        p.name AS player_name
      FROM matches m
      LEFT JOIN teams ht
        ON ht.id = m.home_team_id
      LEFT JOIN teams at
        ON at.id = m.away_team_id
      LEFT JOIN players p
        ON p.id = $2
      WHERE m.id = $1
      `,
      [matchId, playerId]
    );

    const match = matchInfo.rows[0];

    if (match) {
      let notificationTitle = "AliScore";
      let notificationMessage = "";

      if (type === "goal") {
        notificationTitle = "⚽ QOL!";
        notificationMessage =
          `${match.player_name} qol vurdu — ${match.home_team_name} ${match.home_score}:${match.away_score} ${match.away_team_name}`;
      }

      if (type === "own_goal") {
        notificationTitle = "⚽ Avtoqol!";
        notificationMessage =
          `${match.player_name} avtoqol etdi — ${match.home_team_name} ${match.home_score}:${match.away_score} ${match.away_team_name}`;
      }

      if (type === "assist") {
        notificationTitle = "🎯 Assist!";
        notificationMessage =
          `${match.player_name} assist etdi.`;
      }

      if (type === "save") {
        notificationTitle = "🧤 Seyv!";
        notificationMessage =
          `${match.player_name} vacib seyf etdi.`;
      }

      if (type === "yellow") {
        notificationTitle = "🟨 Sarı kart!";
        notificationMessage =
          `${match.player_name} sarı kart aldı.`;
      }

      if (type === "red") {
        notificationTitle = "🟥 Qırmızı kart!";
        notificationMessage =
          `${match.player_name} qırmızı kart aldı.`;
      }

      if (notificationMessage) {
        await createAndSendNotification(
          notificationTitle,
          notificationMessage,
          type,
          {
            match_id: matchId,
            player_id: playerId,
            minute
          }
        );
      }
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET CARDS ERROR:", err);

    res.status(500).json({
      error: "Ошибка загрузки карточек"
    });
  }
});
/* =========================
   NOTIFICATIONS
========================= */

app.get("/api/notifications", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM notifications
      ORDER BY id DESC
      LIMIT 100
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("GET NOTIFICATIONS ERROR:", err);

    res.status(500).json({
      error: "Ошибка загрузки уведомлений"
    });
  }
});

app.post("/api/notifications", admin, async (req, res) => {
  try {
    const title = cleanString(req.body.title);
    const message = cleanString(req.body.message);
    const type = cleanString(req.body.type) || "general";

    if (!title || !message) {
      return res.status(400).json({
        error: "Укажите заголовок и текст уведомления"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO notifications (
        title,
        message,
        type
      )
      VALUES ($1, $2, $3)
      RETURNING *
      `,
      [
        title,
        message,
        type
      ]
    );

    res.json({
      ok: true,
      notification: result.rows[0]
    });
  } catch (err) {
    console.error("CREATE NOTIFICATION ERROR:", err);

    res.status(500).json({
      error: "Ошибка создания уведомления"
    });
  }
});
/* =========================
   PUSH SUBSCRIPTIONS
========================= */
app.get("/api/push/public-key", (req, res) => {
  if (!VAPID_PUBLIC_KEY) {
    return res.status(500).json({
      ok: false,
      error: "VAPID_PUBLIC_KEY не настроен"
    });
  }

  res.json({
    ok: true,
    publicKey: VAPID_PUBLIC_KEY
  });
});
app.post("/api/push/subscribe", async (req, res) => {
  try {
    const subscription = req.body.subscription || req.body;

    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({
        error: "Неверная push-подписка"
      });
    }

    const endpoint = subscription.endpoint;

    const p256dh =
      subscription.keys && subscription.keys.p256dh
        ? subscription.keys.p256dh
        : null;

    const auth =
      subscription.keys && subscription.keys.auth
        ? subscription.keys.auth
        : null;

    await pool.query(
      `
      INSERT INTO push_subscriptions (
        endpoint,
        p256dh,
        auth
      )
      VALUES ($1, $2, $3)
      ON CONFLICT (endpoint)
      DO UPDATE SET
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth
      `,
      [
        endpoint,
        p256dh,
        auth
      ]
    );

    res.json({
      ok: true,
      message: "Push subscription saved"
    });
  } catch (err) {
    console.error("PUSH SUBSCRIBE ERROR:", err);

    res.status(500).json({
      error: "Ошибка сохранения push-подписки"
    });
  }
});

app.delete("/api/push/unsubscribe", async (req, res) => {
  try {
    const endpoint =
      req.body && req.body.endpoint
        ? req.body.endpoint
        : "";

    if (!endpoint) {
      return res.status(400).json({
        error: "Endpoint не указан"
      });
    }

    await pool.query(
      `
      DELETE FROM push_subscriptions
      WHERE endpoint = $1
      `,
      [endpoint]
    );

    res.json({
      ok: true
    });
  } catch (err) {
    console.error("PUSH UNSUBSCRIBE ERROR:", err);

    res.status(500).json({
      error: "Ошибка удаления push-подписки"
    });
  }
});
async function sendPushNotification(title, message, data = {}) {
  try {
    const result = await pool.query(`
      SELECT
        id,
        endpoint,
        p256dh,
        auth
      FROM push_subscriptions
    `);

    if (!result.rows.length) {
      console.log("PUSH: нет активных подписок");
      return {
        sent: 0,
        removed: 0
      };
    }

    const payload = JSON.stringify({
      title: title || "AliScore",
      body: message || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: data || {}
    });

    let sent = 0;
    let removed = 0;

    for (const subscription of result.rows) {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: {
              p256dh: subscription.p256dh,
              auth: subscription.auth
            }
          },
          payload
        );

        sent++;
      } catch (pushError) {
        console.error(
          "PUSH SEND ERROR:",
          pushError.statusCode,
          pushError.message
        );

        /*
          404/410 обычно означает,
          что подписка больше не существует.
        */
        if (
          pushError.statusCode === 404 ||
          pushError.statusCode === 410
        ) {
          await pool.query(
            `
            DELETE FROM push_subscriptions
            WHERE id = $1
            `,
            [subscription.id]
          );

          removed++;
        }
      }
    }

    console.log(
      `PUSH RESULT: sent=${sent}, removed=${removed}`
    );

    return {
      sent,
      removed
    };
  } catch (err) {
    console.error("SEND PUSH ERROR:", err);

    return {
      sent: 0,
      removed: 0,
      error: err.message
    };
  }
}


/* =========================
   TEST PUSH
========================= */

app.post("/api/push/test", admin, async (req, res) => {
  try {
    const title =
      cleanString(req.body.title) ||
      "AliScore";

    const message =
      cleanString(req.body.message) ||
      "Тестовое уведомление работает!";

    const result = await sendPushNotification(
      title,
      message,
      {
        type: "test"
      }
    );

    res.json({
      ok: true,
      ...result
    });
  } catch (err) {
    console.error("TEST PUSH ERROR:", err);

    res.status(500).json({
      error: "Ошибка отправки тестового уведомления"
    });
  }
});
/* =========================
   ALISCORE EVENT NOTIFICATION
========================= */

async function createAndSendNotification(
  title,
  message,
  type = "general",
  data = {}
) {
  try {
    const notification = await pool.query(
      `
      INSERT INTO notifications (
        title,
        message,
        type
      )
      VALUES ($1, $2, $3)
      RETURNING *
      `,
      [
        title,
        message,
        type
      ]
    );

    await sendPushNotification(
      title,
      message,
      {
        type,
        notification_id: notification.rows[0].id,
        ...data
      }
    );

    return notification.rows[0];
  } catch (err) {
    console.error(
      "CREATE AND SEND NOTIFICATION ERROR:",
      err
    );

    return null;
  }
}
