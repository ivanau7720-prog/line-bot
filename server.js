const express = require("express");
const line = require("@line/bot-sdk");
const { createClient } = require("@supabase/supabase-js");

const app = express();

const config = {
  channelAccessToken: "MSoKv1nFk7+A5XOwlF/bg2FL9kfa8nT+gGP/DOLa6zY02XMfbgibLL2xQZ8Dp35UTKUQ0olq/jlDUcjwaApfs+2MCK4kAALknCC/GMwDC4MnUR9BGzPmVtbQLUbL5Gmu1tzmCBg7MhS3XD/VXCSfYwdB04t89/1O/w1cDnyilFU=",
  channelSecret: "945a0301583c7770ae2cbdf7fe3a4483"
};

const client = new line.Client(config);

// ✅ Supabase
const supabase = createClient(
  "https://你的.supabase.co",
  "key    sb_publishable_bWATEwsQd3fU_GKjcLdQzg_1pN6buQE"
);

const ADMIN_ID = "U8455884cfb22877f209092cc78ea9880";

// ===== 状态 =====
let gameOpen = false;
let bets = {};
let names = {};
let currentGroupId = null;

// ===== 清理名字（支持泰文）=====
function cleanName(name) {
  return name
    .replace(/@/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

// ===== 获取用户 =====
async function getUser(userId, name) {
  let { data } = await supabase
    .from("players")
    .select("*")
    .eq("user_id", userId);

  if (!data || data.length === 0) {
    await supabase.from("players").insert([{
      user_id: userId,
      name: name,
      balance: 1000,
      total_win: 0,
      total_lose: 0
    }]);
    return { balance: 1000 };
  }

  return data[0];
}

// ===== webhook =====
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    for (const event of req.body.events) {
      if (event.type !== "message" || event.message.type !== "text") continue;

      const textRaw = event.message.text.trim();
      const text = textRaw.toUpperCase();
      const userId = event.source.userId;

      if (event.source.type === "group") {
        currentGroupId = event.source.groupId;
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

      // ================= 管理员 =================
      if (userId === ADMIN_ID) {

        // ===== 开局 =====
        if (text === "/START") {
          gameOpen = true;
          bets = {};
          setTimeout(closeGame, 60000);
          return reply(event, "🟢 开局 60秒下注");
        }

        // ===== ⭐ 充值系统（修复版）=====
        if (textRaw.toLowerCase().startsWith("/add")) {

          try {
            // 👉 去掉 /add
            let input = textRaw.replace(/\/add/i, "").trim();

            // 👉 提取金额
            let amountMatch = input.match(/([+-]?\d+)/);
            if (!amountMatch) {
              return reply(event, "❌ 用法 /add 名字 +1000");
            }

            let amount = parseInt(amountMatch[1]);

            if (Math.abs(amount) < 1000 || Math.abs(amount) > 100000) {
              return reply(event, "❌ 限制 1000 - 100000");
            }

            // 👉 提取名字
            let namePart = input.replace(amountMatch[1], "").trim();
            let targetName = cleanName(namePart);

            // 👉 读取全部玩家
            let { data } = await supabase.from("players").select("*");

            if (!data || data.length === 0) {
              return reply(event, "❌ 没有玩家数据");
            }

            // 👉 模糊匹配（关键修复）
            let player = data.find(p =>
              cleanName(p.name).includes(targetName)
            );

            if (!player) {
              return reply(event, `❌ 找不到玩家: ${namePart}`);
            }

            let newBalance = player.balance + amount;

            await supabase
              .from("players")
              .update({ balance: newBalance })
              .eq("user_id", player.user_id);

            // 👉 群广播
            if (currentGroupId) {
              await client.pushMessage(currentGroupId, {
                type: "text",
                text:
                  `💰 充值成功\n` +
                  `👤 ${player.name}\n` +
                  `${amount > 0 ? "➕" : "➖"}${Math.abs(amount)}\n` +
                  `💳 余额: ${newBalance}`
              });
            }

            return reply(event, "✅ 已充值");

          } catch (err) {
            console.log(err);
            return reply(event, "❌ 系统错误");
          }
        }
      }

      // ================= 玩家 =================

      if (text === "/BALANCE") {
        return reply(event, `💳 余额: ${userData.balance}`);
      }

      if (!gameOpen) return;

      if (bets[userId]) {
        return reply(event, "❌ 已下注");
      }

      const match = text.match(/^(B|P|T)(\d+)/);
      if (!match) return;

      const side = match[1];
      const amount = parseInt(match[2]);

      if (userData.balance < amount) {
        return reply(event, "❌ 余额不足");
      }

      bets[userId] = { side, amount, name };

      if (currentGroupId) {
        await client.pushMessage(currentGroupId, {
          type: "text",
          text: `📥 ${name} ${side}${amount}`
        });
      }
    }

    res.status(200).end();

  } catch (err) {
    console.log(err);
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
