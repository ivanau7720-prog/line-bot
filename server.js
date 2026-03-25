const express = require("express");
const line = require("@line/bot-sdk");

const app = express();

const config = {
  channelAccessToken: "MSoKv1nFk7+A5XOwlF/bg2FL9kfa8nT+gGP/DOLa6zY02XMfbgibLL2xQZ8Dp35UTKUQ0olq/jlDUcjwaApfs+2MCK4kAALknCC/GMwDC4MnUR9BGzPmVtbQLUbL5Gmu1tzmCBg7MhS3XD/VXCSfYwdB04t89/1O/w1cDnyilFU=",
  channelSecret: "945a0301583c7770ae2cbdf7fe3a4483"
};

const client = new line.Client(config);

// ===== 游戏状态 =====
let gameOpen = false;
let bets = {}; // { userId: { side, amount } }

// ===== 管理员ID（改成你自己的）=====
const ADMIN_ID = "你的LINE userId";

// ===== webhook =====
app.post("/webhook", line.middleware(config), async (req, res) => {
  const events = req.body.events;

  for (const event of events) {
    if (event.type !== "message") continue;

    const text = event.message.text.trim().toUpperCase();
    const userId = event.source.userId;

    // ===== 管理员功能 =====
    if (userId === ADMIN_ID) {

      if (text === "/START") {
        gameOpen = true;
        bets = {};
        return reply(event, "🟢 开局，可以下注！");
      }

      if (text === "/STOP") {
        gameOpen = false;
        return reply(event, "🔴 已关局，停止下注！");
      }

      if (text.startsWith("/RESULT")) {
        const result = text.split(" ")[1]; // B / P / T

        if (!["B", "P", "T"].includes(result)) {
          return reply(event, "❌ 结果必须是 B / P / T");
        }

        let msg = `📊 本局结果：${result}\n\n`;

        for (let user in bets) {
          const bet = bets[user];

          let win = 0;

          // ===== 计算规则 =====
          if (bet.side === result) {
            if (result === "T") {
              win = bet.amount * 8; // 和 8倍（可改）
            } else {
              win = bet.amount; // 庄闲 1:1
            }
          } else {
            win = -bet.amount;
          }

          msg += `${user} : ${win > 0 ? "+" : ""}${win}\n`;
        }

        bets = {};
        return reply(event, msg);
      }
    }

    // ===== 玩家下注 =====
    if (!gameOpen) {
      return reply(event, "❌ 未开局，不能下注");
    }

    // 解析下注 B100 / P200 / T50
    const side = text[0];
    const amount = parseInt(text.slice(1));

    if (!["B", "P", "T"].includes(side)) {
      return; // 忽略无效信息
    }

    if (isNaN(amount) || amount <= 0) {
      return reply(event, "❌ 金额错误");
    }

    bets[userId] = { side, amount };

    return reply(event, `✅ 下注成功：${side} ${amount}`);
  }

  res.status(200).end();
});

// ===== 回复函数 =====
function reply(event, text) {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: text
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("RUNNING"));
