const express = require("express");
const { Pool } = require("pg");

const app = express();

const PORT = process.env.PORT || 10000;

app.use(express.json());

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "AliScore"
  });
});

app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="az">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>AliScore</title>
      <style>
        body {
          margin: 0;
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          background: #07111f;
          color: white;
          font-family: Arial, sans-serif;
        }

        .box {
          text-align: center;
          padding: 30px;
        }

        h1 {
          font-size: 42px;
          margin-bottom: 10px;
        }

        p {
          color: #9fb0c5;
          font-size: 18px;
        }

        .ok {
          display: inline-block;
          margin-top: 20px;
          padding: 12px 20px;
          border-radius: 12px;
          background: #123b2a;
          color: #5cff9d;
        }
      </style>
    </head>

    <body>
      <div class="box">
        <h1>⚽ AliScore</h1>
        <p>Yeni layihə uğurla başladı</p>
        <div class="ok">SERVER ONLINE</div>
      </div>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`AliScore server running on port ${PORT}`);
});
