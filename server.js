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
let history = [];

// ===== 设置 =====
const MIN_BET = 100;
const MAX_BET = 10000;

// ===== 倒计时 =====
let timer = null;
let countdown = 60;

// ===== 获取或创建玩家 =====
async function getUser(userId, name) {
  let { data } = await supabase
    .from("players")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (!data) {
    await supabase.from("players").insert([
      {
        user_id: userId,
        name: name,
        balance: 1000,
        total_win: 0,
        total_lose: 0
      }
    ]);

    return { balance: 1000, total_win: 0, total_lose: 0 };
  }

  return data;
}

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

      // ===== 获取数据库玩家 =====
      const userData = await getUser(userId, name);

      // ================= 管理员 =================
      if (userId === ADMIN_ID) {

        if (text === "/START") {
          gameOpen = true;
          bets = {};
          startTimer(event);
          return reply(event, "🟢 开局（60秒下注）");
        }

        if (text === "/STOP") {
          gameOpen = false;
          clearInterval(timer);
          return reply(event, "🔴 已关局");
        }

        // ===== 结算 =====
        if (text.startsWith("/RESULT")) {
          const result = text.split(" ")[1];

          if (!["B", "P", "T"].includes(result)) {
            return reply(event, "❌ /result B / P / T");
          }

          history.push(result);

          let msg = `📊 本局结果：${result}\n\n`;

          for (let user in bets) {
            const bet = bets[user];

            let win = 0;

            if (bet.side === result) {
              win = result === "T" ? bet.amount * 8 : bet.amount;
            } else {
              win = -bet.amount;
            }

            // ===== 读取旧数据 =====
            let { data } = await supabase
              .from("players")
              .select("*")
              .eq("user_id", user)
              .single();

            let newBalance = data.balance + win;

            await supabase
              .from("players")
              .update({
                balance: newBalance,
                total_win: data.total_win + (win > 0 ? win : 0),
                total_lose: data.total_lose + (win < 0 ? Math.abs(win) : 0)
              })
              .eq("user_id", user);

            msg += `${bet.name} ${win > 0 ? "✅+" : "❌"}${win} | 余额:${newBalance}\n`;
          }

          // ===== 排行榜 =====
          let { data: top } = await supabase
            .from("players")
            .select("*")
            .order("balance", { ascending: false })
            .limit(5);

          msg += "\n🏆 排行榜\n";

          top.forEach((p, i) => {
            msg += `${i + 1}. ${p.name} ${p.balance}\n`;
          });

          // ===== 走势 =====
          msg += "\n📈 走势：\n" + history.slice(-10).join(" ");

          bets = {};

          return broadcast(event, msg);
        }

        // ===== 查余额 =====
        if (text.startsWith("/BALANCE")) {
          const uid = text.split(" ")[1];

          let { data } = await supabase
            .from("players")
            .select("*")
            .eq("user_id", uid)
            .single();

          return reply(event, `余额：${data?.balance || 0}`);
        }

        // ===== 加分 =====
        if (text.startsWith("/ADD")) {
          const [_, uid, amt] = text.split(" ");

          let { data } = await supabase
            .from("players")
            .select("*")
            .eq("user_id", uid)
            .single();

          let newBalance = (data?.balance || 0) + parseInt(amt);

          await supabase
            .from("players")
            .update({ balance: newBalance })
            .eq("user_id", uid);

          return reply(event, `+${amt}`);
        }

        // ===== 扣分 =====
        if (text.startsWith("/SUB")) {
          const [_, uid, amt] = text.split(" ");

          let { data } = await supabase
            .from("players")
            .select("*")
            .eq("user_id", uid)
            .single();

          let newBalance = (data?.balance || 0) - parseInt(amt);

          await supabase
            .from("players")
            .update({ balance: newBalance })
            .eq("user_id", uid);

          return reply(event, `-${amt}`);
        }

        // ===== 排行榜 =====
        if (text === "/TOP") {
          let { data } = await supabase
            .from("players")
            .select("*")
            .order("balance", { ascending: false })
            .limit(5);

          let msg = "🏆 总排行榜\n\n";

          data.forEach((p, i) => {
            msg += `${i + 1}. ${p.name} : ${p.balance}\n`;
          });

          return reply(event, msg);
        }
      }

      // ================= 玩家 =================
      if (!gameOpen) return;

      if (bets[userId]) {
        return reply(event, "❌ 已下注");
      }

      const match = text.match(/^(B|P|T)\s?(\d+)/);
      if (!match) return;

      const side = match[1];
      const amount = parseInt(match[2]);

      if (amount < MIN_BET || amount > MAX_BET) {
        return reply(event, `❌ ${MIN_BET}-${MAX_BET}`);
      }

      if (userData.balance < amount) {
        return reply(event, "❌ 余额不足");
      }

      bets[userId] = { side, amount, name };

      return reply(event, `✅ ${name} ${side}${amount}`);
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
      broadcast(event, `⏳ 剩余 ${countdown} 秒`);
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

  broadcast(event, msg || "无人下注");
}

// ===== 群广播 =====
function broadcast(event, text) {
  return client.pushMessage(event.source.groupId || event.source.userId, {
    type: "text",
    text
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
