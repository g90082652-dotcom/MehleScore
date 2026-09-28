const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const webpush = require("web-push");
const { Pool } = require("pg");

const app = express();

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || "aliscore-secret";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use(express.static(path.join(__dirname, "public")));

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : false
});

/* =====================================================
   WEB PUSH
===================================================== */

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL = process.env.VAPID_EMAIL;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_EMAIL) {
  webpush.setVapidDetails(
    VAPID_EMAIL,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );

  console.log("✅ Web Push configured");
} else {
  console.log("⚠️ Web Push VAPID variables are missing");
}

/* =====================================================
   HEALTH
===================================================== */

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      database: "connected",
      push: !!(
        VAPID_PUBLIC_KEY &&
        VAPID_PRIVATE_KEY &&
        VAPID_EMAIL
      )
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      database: "error",
      error: error.message
    });
  }
});

/* =====================================================
   PUSH PUBLIC KEY
===================================================== */

app.get("/api/push/public-key", (req, res) => {
  if (!VAPID_PUBLIC_KEY) {
    return res.status(500).json({
      ok: false,
      error: "VAPID_PUBLIC_KEY is missing"
    });
  }

  res.json({
    ok: true,
    publicKey: VAPID_PUBLIC_KEY
  });
});

/* =====================================================
   DATABASE
===================================================== */

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      points INTEGER DEFAULT 0,
      played INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      draws INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      goals_for INTEGER DEFAULT 0,
      goals_against INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      number INTEGER,
      position TEXT,
      photo TEXT,
      goals INTEGER DEFAULT 0,
      assists INTEGER DEFAULT 0,
      saves INTEGER DEFAULT 0,
      yellow_cards INTEGER DEFAULT 0,
      red_cards INTEGER DEFAULT 0,
      own_goals INTEGER DEFAULT 0,
      rating NUMERIC DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS matches (
      id SERIAL PRIMARY KEY,
      home_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      away_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      home_score INTEGER DEFAULT 0,
      away_score INTEGER DEFAULT 0,
      date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'finished',
      player_of_match_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS match_events (
      id SERIAL PRIMARY KEY,
      match_id INTEGER REFERENCES matches(id) ON DELETE CASCADE,
      player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      minute INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      endpoint TEXT UNIQUE NOT NULL,
      subscription JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      title TEXT,
      message TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transfers (
      id SERIAL PRIMARY KEY,
      player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
      from_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      to_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      fee NUMERIC DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lineups (
      id SERIAL PRIMARY KEY,
      match_id INTEGER REFERENCES matches(id) ON DELETE CASCADE,
      player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
      team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      position TEXT
    )
  `);

  console.log("✅ Database initialized");
}

/* =====================================================
   ADMIN AUTH
===================================================== */

function adminAuth(req, res, next) {
  try {
    const token = req.cookies.aliscore_admin;

    if (!token) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized"
      });
    }

    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({
      ok: false,
      error: "Unauthorized"
    });
  }
}

/* =====================================================
   ADMIN LOGIN
===================================================== */

app.post("/api/admin/login", (req, res) => {
  const password = String(req.body.password || "");

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({
      ok: false,
      error: "Invalid password"
    });
  }

  const token = jwt.sign(
    { admin: true },
    JWT_SECRET,
    { expiresIn: "30d" }
  );

  res.cookie("aliscore_admin", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 30 * 24 * 60 * 60 * 1000
  });

  res.json({
    ok: true,
    loggedIn: true
  });
});

app.get("/api/admin/me", (req, res) => {
  try {
    const token = req.cookies.aliscore_admin;

    if (!token) {
      return res.json({
        ok: true,
        loggedIn: false
      });
    }

    jwt.verify(token, JWT_SECRET);

    res.json({
      ok: true,
      loggedIn: true
    });
  } catch {
    res.json({
      ok: true,
      loggedIn: false
    });
  }
});

app.post("/api/admin/logout", (req, res) => {
  res.clearCookie("aliscore_admin");

  res.json({
    ok: true
  });
});

/* =====================================================
   TEAMS
===================================================== */

app.get("/api/teams", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *,
      goals_for - goals_against AS goal_difference
      FROM teams
      ORDER BY
        points DESC,
        goal_difference DESC,
        goals_for DESC,
        name ASC
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/api/teams", adminAuth, async (req, res) => {
  try {
    const {
      name,
      points = 0,
      played = 0,
      wins = 0,
      draws = 0,
      losses = 0,
      goals_for = 0,
      goals_against = 0
    } = req.body;

    const result = await pool.query(
      `
      INSERT INTO teams
      (name,points,played,wins,draws,losses,goals_for,goals_against)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
      `,
      [
        name,
        points,
        played,
        wins,
        draws,
        losses,
        goals_for,
        goals_against
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.put("/api/teams/:id", adminAuth, async (req, res) => {
  try {
    const fields = [
      "name",
      "points",
      "played",
      "wins",
      "draws",
      "losses",
      "goals_for",
      "goals_against"
    ];

    const updates = [];
    const values = [];

    for (const field of fields) {
      if (req.body[field] !== undefined) {
        values.push(req.body[field]);
        updates.push(`${field}=$${values.length}`);
      }
    }

    if (!updates.length) {
      return res.status(400).json({
        ok: false,
        error: "Nothing to update"
      });
    }

    values.push(req.params.id);

    const result = await pool.query(
      `
      UPDATE teams
      SET ${updates.join(",")}
      WHERE id=$${values.length}
      RETURNING *
      `,
      values
    );

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.delete("/api/teams/:id", adminAuth, async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM teams WHERE id=$1",
      [req.params.id]
    );

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/* =====================================================
   PLAYERS
===================================================== */

app.get("/api/players", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.*,
        t.name AS team_name
      FROM players p
      LEFT JOIN teams t ON t.id=p.team_id
      ORDER BY p.name
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/api/players", adminAuth, async (req, res) => {
  try {
    const {
      name,
      team_id = null,
      number = null,
      position = "",
      photo = "",
      goals = 0,
      assists = 0,
      saves = 0,
      yellow_cards = 0,
      red_cards = 0,
      own_goals = 0,
      rating = 0
    } = req.body;

    const result = await pool.query(
      `
      INSERT INTO players
      (
        name,team_id,number,position,photo,
        goals,assists,saves,yellow_cards,
        red_cards,own_goals,rating
      )
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
      `,
      [
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
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.put("/api/players/:id", adminAuth, async (req, res) => {
  try {
    const fields = [
      "name",
      "team_id",
      "number",
      "position",
      "photo",
      "goals",
      "assists",
      "saves",
      "yellow_cards",
      "red_cards",
      "own_goals",
      "rating"
    ];

    const updates = [];
    const values = [];

    for (const field of fields) {
      if (req.body[field] !== undefined) {
        values.push(req.body[field]);
        updates.push(`${field}=$${values.length}`);
      }
    }

    if (!updates.length) {
      return res.status(400).json({
        ok: false,
        error: "Nothing to update"
      });
    }

    values.push(req.params.id);

    const result = await pool.query(
      `
      UPDATE players
      SET ${updates.join(",")}
      WHERE id=$${values.length}
      RETURNING *
      `,
      values
    );

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.delete("/api/players/:id", adminAuth, async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM players WHERE id=$1",
      [req.params.id]
    );

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/* =====================================================
   MATCHES
===================================================== */

app.get("/api/matches", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        m.*,
        ht.name AS home_team_name,
        at.name AS away_team_name,
        p.name AS player_of_match_name
      FROM matches m
      LEFT JOIN teams ht ON ht.id=m.home_team_id
      LEFT JOIN teams at ON at.id=m.away_team_id
      LEFT JOIN players p ON p.id=m.player_of_match_id
      ORDER BY m.date DESC,m.id DESC
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/api/matches", adminAuth, async (req, res) => {
  try {
    const {
      home_team_id,
      away_team_id,
      home_score = 0,
      away_score = 0,
      date = new Date(),
      status = "finished",
      player_of_match_id = null
    } = req.body;

    const result = await pool.query(
      `
      INSERT INTO matches
      (
        home_team_id,
        away_team_id,
        home_score,
        away_score,
        date,
        status,
        player_of_match_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
      `,
      [
        home_team_id,
        away_team_id,
        home_score,
        away_score,
        date,
        status,
        player_of_match_id
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.put("/api/matches/:id", adminAuth, async (req, res) => {
  try {
    const fields = [
      "home_team_id",
      "away_team_id",
      "home_score",
      "away_score",
      "date",
      "status",
      "player_of_match_id"
    ];

    const updates = [];
    const values = [];

    for (const field of fields) {
      if (req.body[field] !== undefined) {
        values.push(req.body[field]);
        updates.push(`${field}=$${values.length}`);
      }
    }

    if (!updates.length) {
      return res.status(400).json({
        ok: false,
        error: "Nothing to update"
      });
    }

    values.push(req.params.id);

    const result = await pool.query(
      `
      UPDATE matches
      SET ${updates.join(",")}
      WHERE id=$${values.length}
      RETURNING *
      `,
      values
    );

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.delete("/api/matches/:id", adminAuth, async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM matches WHERE id=$1",
      [req.params.id]
    );

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/* =====================================================
   MATCH EVENTS
===================================================== */

app.get("/api/matches/:id/events", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        e.*,
        p.name AS player_name,
        p.photo AS player_photo
      FROM match_events e
      LEFT JOIN players p ON p.id=e.player_id
      WHERE e.match_id=$1
      ORDER BY e.minute,e.id
      `,
      [req.params.id]
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/api/matches/:id/events", adminAuth, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const {
      player_id,
      type,
      minute = 0
    } = req.body;

    const validTypes = [
      "goal",
      "assist",
      "save",
      "yellow",
      "red",
      "own_goal"
    ];

    if (!validTypes.includes(type)) {
      throw new Error("Yanlış statistika");
    }

    const event = await client.query(
      `
      INSERT INTO match_events
      (match_id,player_id,type,minute)
      VALUES ($1,$2,$3,$4)
      RETURNING *
      `,
      [
        req.params.id,
        player_id || null,
        type,
        minute
      ]
    );

    if (player_id) {
      const columns = {
        goal: "goals",
        assist: "assists",
        save: "saves",
        yellow: "yellow_cards",
        red: "red_cards",
        own_goal: "own_goals"
      };

      const column = columns[type];

      if (column) {
        await client.query(
          `
          UPDATE players
          SET ${column}=COALESCE(${column},0)+1
          WHERE id=$1
          `,
          [player_id]
        );
      }

      if (
        type === "goal" ||
        type === "assist" ||
        type === "save"
      ) {
        await client.query(
          `
          UPDATE players
          SET rating=COALESCE(rating,0)+1
          WHERE id=$1
          `,
          [player_id]
        );
      }

      if (type === "yellow") {
        await client.query(
          `
          UPDATE players
          SET rating=COALESCE(rating,0)-1
          WHERE id=$1
          `,
          [player_id]
        );
      }

      if (type === "red") {
        await client.query(
          `
          UPDATE players
          SET rating=COALESCE(rating,0)-2
          WHERE id=$1
          `,
          [player_id]
        );
      }
    }

    await client.query("COMMIT");

    res.json(event.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");

    res.status(400).json({
      ok: false,
      error: error.message
    });
  } finally {
    client.release();
  }
});

app.put(
  "/api/matches/:matchId/events/:eventId",
  adminAuth,
  async (req, res) => {
    try {
      const result = await pool.query(
        `
        UPDATE match_events
        SET
          player_id=COALESCE($1,player_id),
          type=COALESCE($2,type),
          minute=COALESCE($3,minute)
        WHERE id=$4
        AND match_id=$5
        RETURNING *
        `,
        [
          req.body.player_id,
          req.body.type,
          req.body.minute,
          req.params.eventId,
          req.params.matchId
        ]
      );

      res.json(result.rows[0]);
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message
      });
    }
  }
);

app.delete(
  "/api/matches/:matchId/events/:eventId",
  adminAuth,
  async (req, res) => {
    try {
      await pool.query(
        `
        DELETE FROM match_events
        WHERE id=$1 AND match_id=$2
        `,
        [
          req.params.eventId,
          req.params.matchId
        ]
      );

      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error.message
      });
    }
  }
);

/* =====================================================
   STATISTICS
===================================================== */

app.get("/api/statistics", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.*,
        t.name AS team_name
      FROM players p
      LEFT JOIN teams t ON t.id=p.team_id
      ORDER BY
        p.goals DESC,
        p.assists DESC,
        p.saves DESC
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/* =====================================================
   CARDS
===================================================== */

app.get("/api/cards", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.id,
        p.name,
        p.yellow_cards,
        p.red_cards,
        t.name AS team_name
      FROM players p
      LEFT JOIN teams t ON t.id=p.team_id
      WHERE
        COALESCE(p.yellow_cards,0)>0
        OR COALESCE(p.red_cards,0)>0
      ORDER BY
        p.red_cards DESC,
        p.yellow_cards DESC
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/* =====================================================
   LINEUPS
===================================================== */

app.get("/api/lineups", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        l.*,
        p.name AS player_name,
        p.photo,
        t.name AS team_name
      FROM lineups l
      LEFT JOIN players p ON p.id=l.player_id
      LEFT JOIN teams t ON t.id=l.team_id
      ORDER BY l.id
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/api/lineups", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `
      INSERT INTO lineups
      (match_id,player_id,team_id,position)
      VALUES ($1,$2,$3,$4)
      RETURNING *
      `,
      [
        req.body.match_id,
        req.body.player_id,
        req.body.team_id,
        req.body.position
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/* =====================================================
   TRANSFERS
===================================================== */

app.get("/api/transfers", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        tr.*,
        p.name AS player_name,
        ft.name AS from_team_name,
        tt.name AS to_team_name
      FROM transfers tr
      LEFT JOIN players p ON p.id=tr.player_id
      LEFT JOIN teams ft ON ft.id=tr.from_team_id
      LEFT JOIN teams tt ON tt.id=tr.to_team_id
      ORDER BY tr.created_at DESC
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/api/transfers", adminAuth, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const {
      player_id,
      from_team_id = null,
      to_team_id,
      fee = 0
    } = req.body;

    const transfer = await client.query(
      `
      INSERT INTO transfers
      (player_id,from_team_id,to_team_id,fee)
      VALUES ($1,$2,$3,$4)
      RETURNING *
      `,
      [
        player_id,
        from_team_id,
        to_team_id,
        fee
      ]
    );

    await client.query(
      `
      UPDATE players
      SET team_id=$1
      WHERE id=$2
      `,
      [
        to_team_id,
        player_id
      ]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      transfer: transfer.rows[0]
    });
  } catch (error) {
    await client.query("ROLLBACK");

    res.status(400).json({
      ok: false,
      error: error.message
    });
  } finally {
    client.release();
  }
});

/* =====================================================
   PUSH SUBSCRIBE
===================================================== */

app.post("/api/push/subscribe", async (req, res) => {
  try {
    const subscription = req.body;

    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({
        ok: false,
        error: "Invalid subscription"
      });
    }

    await pool.query(
      `
      INSERT INTO push_subscriptions
      (endpoint,subscription)
      VALUES ($1,$2)
      ON CONFLICT (endpoint)
      DO UPDATE SET subscription=$2
      `,
      [
        subscription.endpoint,
        JSON.stringify(subscription)
      ]
    );

    res.json({
      ok: true
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/* =====================================================
   SEND PUSH
===================================================== */

async function sendPush(title, message, data = {}) {
  if (
    !VAPID_PUBLIC_KEY ||
    !VAPID_PRIVATE_KEY ||
    !VAPID_EMAIL
  ) {
    console.log("Push skipped: VAPID not configured");
    return;
  }

  const result = await pool.query(
    "SELECT id,subscription FROM push_subscriptions"
  );

  for (const row of result.rows) {
    try {
      await webpush.sendNotification(
        row.subscription,
        JSON.stringify({
          title,
          body: message,
          data
        })
      );
    } catch (error) {
      console.error(
        "Push error:",
        error.statusCode,
        error.message
      );

      if (
        error.statusCode === 404 ||
        error.statusCode === 410
      ) {
        await pool.query(
          "DELETE FROM push_subscriptions WHERE id=$1",
          [row.id]
        );
      }
    }
  }
}

app.post("/api/push/test", adminAuth, async (req, res) => {
  try {
    await sendPush(
      "AliScore ⚽",
      "Тестовое уведомление работает!",
      { type: "test" }
    );

    res.json({
      ok: true
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/* =====================================================
   NOTIFICATIONS
===================================================== */

app.get("/api/notifications", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM notifications
      ORDER BY created_at DESC
      LIMIT 100
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/api/notifications", adminAuth, async (req, res) => {
  try {
    const {
      title = "AliScore",
      message = ""
    } = req.body;

    const result = await pool.query(
      `
      INSERT INTO notifications
      (title,message)
      VALUES ($1,$2)
      RETURNING *
      `,
      [title, message]
    );

    await sendPush(
      title,
      message
    );

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/* =====================================================
   DREAM TEAM
===================================================== */

app.get("/api/team-of-week", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.*,
        t.name AS team_name
      FROM players p
      LEFT JOIN teams t ON t.id=p.team_id
      ORDER BY
        COALESCE(p.rating,0) DESC,
        COALESCE(p.goals,0) DESC,
        COALESCE(p.assists,0) DESC
      LIMIT 11
    `);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/* =====================================================
   404 API
===================================================== */

app.use("/api", (req, res) => {
  res.status(404).json({
    ok: false,
    error: "API route not found",
    path: req.path
  });
});

/* =====================================================
   FRONTEND
===================================================== */

app.get("*", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

/* =====================================================
   START
===================================================== */

async function start() {
  try {
    if (DATABASE_URL) {
      await initDatabase();
    } else {
      console.log("⚠️ DATABASE_URL is missing");
    }

    app.listen(PORT, "0.0.0.0", () => {
      console.log(
        `🚀 AliScore running on port ${PORT}`
      );
      console.log(
        `🔑 Push API: /api/push/public-key`
      );
    });
  } catch (error) {
    console.error(
      "❌ START ERROR:",
      error
    );

    process.exit(1);
  }
}

start();
