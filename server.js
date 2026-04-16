const express = require("express");
const line = require("@line/bot-sdk");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ===== CONFIG =====
const ADMIN_ID = process.env.ADMIN_ID;

const client = new line.Client({
  channelAccessToken: process.env.LINE_TOKEN,
  channelSecret: process.env.LINE_SECRET
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ===== 🇹🇭 泰语广播 =====
const TH = {
  START: "🟢 เปิดรอบ! กรุณาวางเดิมพัน (60 วินาที)",
  TIME: (t) => `⏳ เหลือ ${t} วินาที`,
  STOP: "⛔ ปิดรับเดิมพัน",
  RESULT: (r) => `🎯 ผลออก: ${r}`,
  BET: (name, side, amount) => `✅ ${name} แทง ${side} ${amount}`,
  NO_MONEY: "❌ เงินไม่พอ",
  DONE: "✅ เสร็จสิ้น",
  RUNNING: "⚠️ เกมกำลังดำเนินอยู่",
  WAIT: "⚠️ กรุณาออกผลก่อน"
};

// ===== GAME =====
let GAME = {
  groupId: null,
  isBetting: false,
  waitingResult: false,
  bets: {}
};

let MONITOR = { B: 0, P: 0, T: 0 };
let COUNT = { B: 0, P: 0, T: 0 };

// ===== 🚀 防429 =====
let QUEUE = [];
let sending = false;
let delay = 1200;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runQueue() {
  if (sending) return;
  sending = true;

  while (QUEUE.length) {
    const job = QUEUE.shift();

    try {
      await client.pushMessage(job.to, job.msg);
      delay = Math.max(1000, delay - 100);
    } catch (err) {
      if (err.statusCode === 429) {
        delay = Math.min(8000, delay + 1500);
        QUEUE.unshift(job);
      }
    }

    await sleep(delay);
  }

  sending = false;
}

function send(to, msg) {
  QUEUE.push({ to, msg });
  runQueue();
}

function broadcast(text) {
  if (!GAME.groupId) return;
  send(GAME.groupId, { type: "text", text });
}

// ===== DB =====
async function getUser(userId) {
  let { data } = await supabase
    .from("players")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (!data) {
    data = {
      user_id: userId,
      balance: 0,
      total_topup: 0,
      name: "PLAYER"
    };
    await supabase.from("players").insert([data]);
  }

  return data;
}

async function changeBalance(userId, amount) {
  const { data } = await supabase
    .from("players")
    .select("*")
    .eq("user_id", userId)
    .single();

  await supabase.from("players").update({
    balance: data.balance + amount,
    total_topup: data.total_topup + (amount > 0 ? amount : 0)
  }).eq("user_id", userId);
}

// ===== WEBHOOK =====
app.post("/webhook", line.middleware({
  channelAccessToken: process.env.LINE_TOKEN,
  channelSecret: process.env.LINE_SECRET
}), async (req, res) => {

  try {
    for (const event of req.body.events) {

      if (event.type !== "message") continue;
      if (event.message.type !== "text") continue;

      const userId = event.source.userId;
      const groupId = event.source.groupId;

      if (groupId) GAME.groupId = groupId;

      const text = event.message.text.trim().toUpperCase();
      const user = await getUser(userId);

      // ===== START =====
      if (text === "/START" && userId === ADMIN_ID) {

        if (GAME.isBetting || GAME.waitingResult) {
          return client.replyMessage(event.replyToken, {
            type: "text",
            text: TH.RUNNING
          });
        }

        GAME.isBetting = true;
        GAME.waitingResult = false;
        GAME.bets = {};

        MONITOR = { B: 0, P: 0, T: 0 };
        COUNT = { B: 0, P: 0, T: 0 };

        broadcast(TH.START);

        let time = 60;
        const timer = setInterval(() => {
          time -= 10;

          if (time <= 0) {
            clearInterval(timer);
            GAME.isBetting = false;
            GAME.waitingResult = true;
            broadcast(TH.STOP);
          } else {
            broadcast(TH.TIME(time));
          }

        }, 10000);

        return client.replyMessage(event.replyToken, {
          type: "text",
          text: "OK"
        });
      }

      // ===== BET =====
      if (/^[BPT]\d+$/.test(text)) {

        if (!GAME.isBetting) return;

        const side = text[0];
        const amount = Number(text.slice(1));

        if (user.balance < amount) {
          return client.replyMessage(event.replyToken, {
            type: "text",
            text: TH.NO_MONEY
          });
        }

        await changeBalance(userId, -amount);
        GAME.bets[userId] = { side, amount };

        MONITOR[side] += amount;
        COUNT[side]++;

        return client.replyMessage(event.replyToken, {
          type: "text",
          text: TH.BET(user.name, side, amount)
        });
      }

      // ===== RESULT =====
      if (text.startsWith("/RESULT") && userId === ADMIN_ID) {

        if (!GAME.waitingResult) {
          return client.replyMessage(event.replyToken, {
            type: "text",
            text: TH.WAIT
          });
        }

        const result = text.split(" ")[1];

        let report = `${TH.RESULT(result)}\n\n`;

        for (const uid in GAME.bets) {

          const bet = GAME.bets[uid];
          const u = await getUser(uid);

          let change;

          if (bet.side === result) {

            if (result === "B") {
              change = bet.amount * 0.95;
              await changeBalance(uid, bet.amount * 1.95);
            } else if (result === "P") {
              change = bet.amount;
              await changeBalance(uid, bet.amount * 2);
            } else {
              change = bet.amount * 8;
              await changeBalance(uid, bet.amount * 9);
            }

          } else {
            change = -bet.amount;
          }

          await supabase.from("transactions").insert([{
            user_id: uid,
            name: u.name,
            amount: bet.amount,
            bet_side: bet.side,
            result,
            win_amount: change
          }]);

          report += `${u.name} ${change > 0 ? "+" : ""}${change}\n`;
        }

        broadcast(report);

        GAME.bets = {};

        return client.replyMessage(event.replyToken, {
          type: "text",
          text: TH.DONE
        });
      }

    }

    res.sendStatus(200);

  } catch (err) {
    console.log(err);
    res.sendStatus(500);
  }
});

// ===== ADMIN =====
app.use(express.urlencoded({ extended: true }));

app.get("/admin", async (req, res) => {

  const { data: players } = await supabase.from("players").select("*");

  let html = "<body style='background:black;color:white'>";

  players.forEach(p => {
    html += `
    <div>
      👤 ${p.name} (${p.user_id}) 💰${p.balance}
      <form method="POST" action="/topup">
        <input name="user_id" value="${p.user_id}" hidden/>
        <input name="amount"/>
        <button>充值</button>
      </form>
    </div>`;
  });

  res.send(html);
});

app.post("/topup", async (req, res) => {
  await changeBalance(req.body.user_id, Number(req.body.amount));
  res.redirect("/admin");
});

// ===== MONITOR =====
app.get("/monitor", (req, res) => {
  const total = MONITOR.B + MONITOR.P + MONITOR.T;

  res.send(`
  <body style="background:black;color:white;text-align:center">
    <h2>B ${MONITOR.B}</h2>
    <h2>P ${MONITOR.P}</h2>
    <h2>T ${MONITOR.T}</h2>
    <h2>Total ${total}</h2>
  </body>
  `);
});

app.listen(process.env.PORT || 3000);
