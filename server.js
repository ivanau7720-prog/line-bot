const express = require("express");
const line = require("@line/bot-sdk");
const { createClient } = require("@supabase/supabase-js");

const app = express();

const config = {
  channelAccessToken: "MSoKv1nFk7+A5XOwlF/bg2FL9kfa8nT+gGP/DOLa6zY02XMfbgibLL2xQZ8Dp35UTKUQ0olq/jlDUcjwaApfs+2MCK4kAALknCC/GMwDC4MnUR9BGzPmVtbQLUbL5Gmu1tzmCBg7MhS3XD/VXCSfYwdB04t89/1O/w1cDnyilFU=",
  channelSecret: "945a0301583c7770ae2cbdf7fe3a4483"
};

const client = new line.Client(config);

// ===== Supabase =====
const supabase = createClient(
  "https://riqystgmpvxwsebyavuo.supabase.co",
  "sb_publishable_bWATEwsQd3fU_GKjcLdQzg_1pN6buQE"
);

// ===== 管理员 =====
const ADMIN_ID = "U8455884cfb22877f209092cc78ea9880";

// ===== 游戏状态 =====
let gameOpen = false;
let bets = {};
let names = {};
let timer = null;
let countdown = 60;
let currentGroupId = null;

// ===== 走势 =====
let history = [];

// ===== 设置 =====
const MIN_BET = 100;
const MAX_BET = 10000;

// ===== 只发群消息 =====
async function sendToGroup(text) {
  if (!currentGroupId) return;
  try {
    await client.pushMessage(currentGroupId, {
      type: "text",
      text
    });
  } catch (err) {
    console.log("群发失败:", err);
  }
}

// ===== 获取用户 =====
async function getUser(userId, name) {
  try {
    let { data } = await supabase
      .from("players")
      .select("*")
      .eq("user_id", userId);

    if (!data || data.length === 0) {
      await supabase.from("players").insert([{
        user_id: userId,
        name,
        balance: 1000,
        total_win: 0,
        total_lose: 0
      }]);
      return { balance: 1000, total_win: 0, total_lose: 0 };
    }

    return data[0];
  } catch (err) {
    console.log("DB ERROR:", err);
    return { balance: 1000, total_win: 0, total_lose: 0 };
  }
}

// ===== emoji =====
function getEmoji(r) {
  if (r === "B") return "🔴";
  if (r === "P") return "🔵";
  if (r === "T") return "🟢";
}

// ===== 走势图 =====
function buildBoard() {
  let msg = "📊 开奖记录\n\n";
  history.forEach((r, i) => {
    msg += getEmoji(r) + " ";
    if ((i + 1) % 10 === 0) msg += "\n";
  });
  return msg;
}

// ===== 倒计时 =====
function startCountdown() {
  countdown = 60;

  timer = setInterval(() => {
    countdown--;

    if (countdown % 10 === 0 && countdown > 0) {
      sendToGroup(`⏰ 剩余 ${countdown} 秒`);
    }

    if (countdown <= 0) {
      clearInterval(timer);
      gameOpen = false;

      let msg = "🔴 已关局\n\n📊 下注列表：\n";

      for (let u in bets) {
        let b = bets[u];
        msg += `${b.name} ${b.side}${b.amount}\n`;
      }

      sendToGroup(msg || "无人下注");
    }

  }, 1000);
}

// ===== webhook =====
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events;

    for (const event of events) {
      if (event.type !== "message" || event.message.type !== "text") continue;

      const text = event.message.text.trim().toUpperCase();
      const userId = event.source.userId;

      // ✅ 记录群ID（关键）
      if (event.source.type === "group" || event.source.type === "room") {
        currentGroupId = event.source.groupId || event.source.roomId;
      }

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
      const userData = await getUser(userId, name);

      // ===== 管理员 =====
      if (userId === ADMIN_ID) {

        if (text === "/START") {
          gameOpen = true;
          bets = {};

          reply(event, "🟢 开局！60秒下注");
          startCountdown();
          return;
        }

        if (text === "/STOP") {
          gameOpen = false;
          clearInterval(timer);
          return reply(event, "🔴 已关局");
        }

        if (text.startsWith("/RESULT")) {
          const result = text.split(" ")[1];

          if (!["B", "P", "T"].includes(result)) {
            return reply(event, "❌ /result B/P/T");
          }

          history.push(result);
          if (history.length > 30) history = [];

          let msg = `📊 本局结果：${result} ${getEmoji(result)}\n\n`;

          let ranking = [];

          for (let user in bets) {
            const bet = bets[user];

            let win = bet.side === result
              ? (result === "T" ? bet.amount * 8 : bet.amount)
              : -bet.amount;

            let { data } = await supabase
              .from("players")
              .select("*")
              .eq("user_id", user);

            let player = data?.[0];
            if (!player) continue;

            let newBalance = player.balance + win;

            await supabase
              .from("players")
              .update({
                balance: newBalance,
                total_win: win > 0 ? player.total_win + win : player.total_win,
                total_lose: win < 0 ? player.total_lose + Math.abs(win) : player.total_lose
              })
              .eq("user_id", user);

            ranking.push({
              name: bet.name,
              win
            });
          }

          // ===== 排行榜 =====
          ranking.sort((a, b) => b.win - a.win);

          msg += "🏆 排行榜\n";
          ranking.forEach((p, i) => {
            msg += `${i + 1}. ${p.name} ${p.win > 0 ? "✅+" : "❌"}${p.win}\n`;
          });

          bets = {};

          msg += "\n" + buildBoard();

          // ✅ 只发群
          sendToGroup(msg);

          return reply(event, "✅ 已结算并广播");
        }
      }

      // ===== 玩家下注 =====
      if (!gameOpen) return reply(event, "❌ 已关局");

      if (bets[userId]) {
        return reply(event, "❌ 已下注");
      }

      const match = text.match(/^(B|P|T)(\d+)/);
      if (!match) return;

      const side = match[1];
      const amount = parseInt(match[2]);

      if (amount < MIN_BET || amount > MAX_BET) {
        return reply(event, "❌ 限制100-10000");
      }

      if (userData.balance < amount) {
        return reply(event, "❌ 余额不足");
      }

      bets[userId] = { side, amount, name };

      // ✅ 只群广播
      sendToGroup(`📥 ${name} 下注 ${side}${amount}`);

      return reply(event, `✅ ${name} ${side}${amount}`);
    }

    res.status(200).end();

  } catch (err) {
    console.log("🔥 ERROR:", err);
    res.status(500).end();
  }
});

// ===== 回复 =====
function reply(event, text) {
  return client.replyMessage(event.replyToken, {
    type: "text",
    text
  });
}

app.listen(process.env.PORT || 3000, () => {
  console.log("RUNNING");
});
