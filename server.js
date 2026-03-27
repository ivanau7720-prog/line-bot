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
  "https://你的.supabase.co",
  "sb_publishable_bWATEwsQd3fU_GKjcLdQzg_1pN6buQE"
);

// ===== 管理员 =====
const ADMIN_ID = "你的管理员ID";

// ===== 状态 =====
let gameOpen = false;
let bets = {};
let names = {};
let history = [];
let currentGroupId = null;

// ===== 设置 =====
const MIN_BET = 100;
const MAX_BET = 10000;

// ===== 获取用户 =====
async function getUser(userId, name) {
  let { data } = await supabase
    .from("players")
    .select("*")
    .eq("user_id", userId);

  if (!data || data.length === 0) {
    await supabase.from("players").insert([
      {
        user_id: userId,
        name: name,
        balance: 1000,
        total_win: 0,
        total_lose: 0
      }
    ]);

    return { balance: 1000 };
  }

  return data[0];
}

// ===== webhook =====
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events;

    for (const event of events) {
      if (event.type !== "message" || event.message.type !== "text") continue;

      const textRaw = event.message.text.trim();
      const text = textRaw.toUpperCase();
      const userId = event.source.userId;

      if (event.source.type === "group") {
        currentGroupId = event.source.groupId;
      }

      // ===== 获取名字（支持泰文）=====
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

      // ================== 管理员 ==================
      if (userId === ADMIN_ID) {

        // ===== 开局 =====
        if (text === "/START") {
          gameOpen = true;
          bets = {};

          setTimeout(() => closeGame(), 60000); // 60秒

          return reply(event, "🟢 开局！60秒下注");
        }

        // ===== 充值（支持名字 + 泰文 + 加减）=====
        if (text.startsWith("/ADD")) {
          const parts = textRaw.split(" ");

          if (parts.length < 3) {
            return reply(event, "❌ 用法：/add 名字 +1000");
          }

          const targetName = parts[1];
          let amount = parseInt(parts[2]);

          if (isNaN(amount)) return reply(event, "❌ 金额错误");

          // 查名字（支持泰文）
          let { data } = await supabase
            .from("players")
            .select("*")
            .ilike("name", targetName);

          if (!data || data.length === 0) {
            return reply(event, "❌ 找不到玩家");
          }

          let player = data[0];
          let newBalance = player.balance + amount;

          await supabase
            .from("players")
            .update({ balance: newBalance })
            .eq("user_id", player.user_id);

          if (currentGroupId) {
            await client.pushMessage(currentGroupId, {
              type: "text",
              text: `💰 充值成功\n👤 ${player.name}\n${amount > 0 ? "➕" : "➖"}${Math.abs(amount)}\n💳 ${newBalance}`
            });
          }

          return reply(event, "✅ 完成");
        }

        // ===== 结算 =====
        if (text.startsWith("/RESULT")) {
          const result = text.split(" ")[1];

          if (!["B", "P", "T"].includes(result)) {
            return reply(event, "❌ /result B/P/T");
          }

          let msg = `📊 本局结果：${result} ${result === "B" ? "🔴" : result === "P" ? "🔵" : "🟢"}\n\n`;

          let leaderboard = [];

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

            let totalWin = player.total_win || 0;
            let totalLose = player.total_lose || 0;

            if (win > 0) totalWin += win;
            else totalLose += Math.abs(win);

            await supabase
              .from("players")
              .update({
                balance: newBalance,
                total_win: totalWin,
                total_lose: totalLose
              })
              .eq("user_id", user);

            leaderboard.push({
              name: bet.name,
              win
            });

            msg += `${bet.name} ${win > 0 ? "✅+" : "❌"}${win}\n`;
          }

          leaderboard.sort((a, b) => b.win - a.win);

          let rankMsg = "\n🏆 排行榜\n";
          leaderboard.forEach((p, i) => {
            rankMsg += `${i + 1}. ${p.name} (${p.win > 0 ? "+" : ""}${p.win})\n`;
          });

          history.push(result === "B" ? "🔴" : result === "P" ? "🔵" : "🟢");
          if (history.length > 30) history = [];

          let historyMsg = "\n📊 开奖记录\n" + history.join(" ");

          bets = {};
          gameOpen = false;

          if (currentGroupId) {
            await client.pushMessage(currentGroupId, {
              type: "text",
              text: msg + rankMsg + historyMsg
            });
          }

          return reply(event, "✅ 已结算并广播");
        }
      }

      // ================== 玩家 ==================

      if (!gameOpen) return;

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

      if (currentGroupId) {
        await client.pushMessage(currentGroupId, {
          type: "text",
          text: `📥 ${name} 下注 ${side}${amount}`
        });
      }

    }

    res.status(200).end();

  } catch (err) {
    console.log("ERROR:", err);
    res.status(500).end();
  }
});

// ===== 自动关局 =====
async function closeGame() {
  gameOpen = false;

  let list = "📊 下注列表\n";
  for (let u in bets) {
    let b = bets[u];
    list += `${b.name} ${b.side}${b.amount}\n`;
  }

  if (currentGroupId) {
    await client.pushMessage(currentGroupId, {
      type: "text",
      text: "🔴 已关局\n\n" + list
    });
  }
}

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
