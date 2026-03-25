const express = require("express");
const line = require("@line/bot-sdk");

const app = express();

const config = {
  channelAccessToken: "MSoKv1nFk7+A5XOwlF/bg2FL9kfa8nT+gGP/DOLa6zY02XMfbgibLL2xQZ8Dp35UTKUQ0olq/jlDUcjwaApfs+2MCK4kAALknCC/GMwDC4MnUR9BGzPmVtbQLUbL5Gmu1tzmCBg7MhS3XD/VXCSfYwdB04t89/1O/w1cDnyilFU=",
  channelSecret: "945a0301583c7770ae2cbdf7fe3a4483"
};

const client = new line.Client(config);

// ===== 管理员 =====
const ADMIN_ID = "U8455884cfb22877f209092cc78ea9880";

// ===== 游戏状态 =====
let gameOpen = false;
let bets = {};
let balance = {};
let names = {};

// ===== 设置 =====
const MIN_BET = 100;
const MAX_BET = 10000;

// ===== 倒计时 =====
let timer = null;
let countdown = 60;

// ===== webhook =====
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events;

    for (const event of events) {

      if (event.type !== "message" || event.message.type !== "text") continue;

      const text = event.message.text.trim().toUpperCase();
      const userId = event.source.userId;

      // ===== 获取名字 =====
      if (!names[userId]) {
        try {
          const profile = await client.getProfile(userId);
          names[userId] = profile.displayName;
        } catch {
          names[userId] = "玩家";
        }
      }

      const name = names[userId];

      // ===== 初始化余额 =====
      if (!balance[userId]) balance[userId] = 0;

      // ================= 管理员 =================
      if (userId === ADMIN_ID) {

        // ===== 开局 =====
        if (text === "/START") {
          gameOpen = true;
          bets = {};
          startTimer(event);
          return reply(event, "🟢 开局，60秒下注！");
        }

        // ===== 关局 =====
        if (text === "/STOP") {
          gameOpen = false;
          clearInterval(timer);
          return reply(event, "🔴 已关局！");
        }

        // ===== 结算 =====
        if (text.startsWith("/RESULT")) {
          const result = text.split(" ")[1];

          if (!["B", "P", "T"].includes(result)) {
            return reply(event, "❌ /result B / P / T");
          }

          let msg = `📊 结果：${result}\n\n`;

          for (let user in bets) {
            const bet = bets[user];
            let win = 0;

            if (bet.side === result) {
              win = result === "T" ? bet.amount * 8 : bet.amount;
            } else {
              win = -bet.amount;
            }

            balance[user] += win;

            msg += `${bet.name} ${win > 0 ? "✅+" : "❌"}${win} 余额:${balance[user]}\n`;
          }

          bets = {};
          return reply(event, msg || "无人下注");
        }

        // ===== 加分 =====
        if (text.startsWith("/ADD")) {
          const [_, uid, amt] = text.split(" ");
          balance[uid] = (balance[uid] || 0) + parseInt(amt);
          return reply(event, `已加分 ${uid} +${amt}`);
        }

        // ===== 减分 =====
        if (text.startsWith("/SUB")) {
          const [_, uid, amt] = text.split(" ");
          balance[uid] = (balance[uid] || 0) - parseInt(amt);
          return reply(event, `已扣分 ${uid} -${amt}`);
        }

        // ===== 排行榜 =====
        if (text === "/TOP") {
          let ranking = Object.entries(balance)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);

          let msg = "🏆 排行榜\n\n";

          ranking.forEach((r, i) => {
            msg += `${i + 1}. ${names[r[0]]} : ${r[1]}\n`;
          });

          return reply(event, msg);
        }
      }

      // ================= 玩家 =================
      if (!gameOpen) {
        return reply(event, "❌ 未开局");
      }

      // 防重复下注
      if (bets[userId]) {
        return reply(event, "❌ 已下注");
      }

      const match = text.match(/^(B|P|T)\s?(\d+)/);
      if (!match) return;

      const side = match[1];
      const amount = parseInt(match[2]);

      if (amount < MIN_BET || amount > MAX_BET) {
        return reply(event, `❌ 限制 ${MIN_BET}-${MAX_BET}`);
      }

      if (balance[userId] < amount) {
        return reply(event, "❌ 余额不足");
      }

      bets[userId] = { side, amount, name };

      return reply(event, `✅ ${name} 下注 ${side}${amount}`);
    }

    res.status(200).end();

  } catch (err) {
    console.log(err);
    res.status(500).end();
  }
});

// ===== 倒计时 =====
function startTimer(event) {
  countdown = 60;

  timer = setInterval(() => {
    countdown--;

    if (countdown % 10 === 0 && countdown > 0) {
      client.pushMessage(event.source.groupId || event.source.userId, {
        type: "text",
        text: `⏳ 剩余 ${countdown} 秒`
      });
    }

    if (countdown <= 0) {
      clearInterval(timer);
      gameOpen = false;

      broadcastBets(event);
    }
  }, 1000);
}

// ===== 广播下注 =====
function broadcastBets(event) {
  let msg = "📋 本局下注\n\n";

  for (let user in bets) {
    const b = bets[user];
    msg += `${b.name} ${b.side}${b.amount}\n`;
  }

  client.pushMessage(event.source.groupId || event.source.userId, {
    type: "text",
    text: msg || "无人下注"
  });
}

// ===== 回复 =====
function reply(event, text) {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("RUNNING"));
