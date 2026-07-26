/**
 * Telegram bot that answers blockchain questions, paying per answer.
 *
 *   TELEGRAM_BOT_TOKEN=... ALGORAND_PRIVATE_KEY="25 words" node bot.mjs
 *
 * Commands:
 *   /token <asa-id>      rug check
 *   /wallet <address>    wallet risk
 *   /tx <txid>           what a transaction did
 *   /trending            what is moving on Algorand
 *   anything else        routed through /ask
 *
 * No dependencies beyond the SDK — it long-polls the Bot API with fetch.
 */
import { VerdictClient, PaymentNotConfiguredError } from "verdict-sdk";

const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
  console.error("TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather and set it.");
  process.exit(1);
}

const verdict = new VerdictClient({
  privateKey: process.env.ALGORAND_PRIVATE_KEY,
  baseUrl: process.env.VERDICT_URL,
});
const api = `https://api.telegram.org/bot${botToken}`;

async function send(chatId, text) {
  await fetch(`${api}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
  });
}

async function handle(text) {
  const [command, ...rest] = text.trim().split(/\s+/);
  const argument = rest.join(" ");

  switch (command) {
    case "/start":
    case "/help":
      return (
        "I answer questions about Algorand, and pay for each answer myself.\n\n" +
        "/token <asa-id> — rug check\n" +
        "/wallet <address> — wallet risk\n" +
        "/tx <txid> — what a transaction did\n" +
        "/trending — what is moving right now\n\n" +
        "Or just ask a question in plain language."
      );

    case "/token": {
      if (!argument) return "Usage: /token <asa-id>, e.g. /token 31566704";
      const token = await verdict.analyzeToken({ asset: argument, chain: "algorand" });
      return (
        `${token.symbol ?? token.name ?? argument}\n` +
        `rug probability: ${token.rug_probability ?? "unknown"}\n` +
        `signals: ${token.rug_signals.join(", ") || "none"}\n\n` +
        token.verdict
      );
    }

    case "/wallet": {
      if (!argument) return "Usage: /wallet <address>";
      const wallet = await verdict.analyzeWallet({ address: argument, chain: "algorand" });
      return (
        `risk ${wallet.risk_score ?? "unknown"} (confidence ${wallet.confidence ?? "unknown"})\n` +
        `labels: ${wallet.labels.join(", ") || "none"}\n\n` +
        wallet.verdict
      );
    }

    case "/tx": {
      if (!argument) return "Usage: /tx <transaction-id>";
      const tx = await verdict.explainTransaction({ txid: argument });
      return tx.summary;
    }

    case "/trending": {
      const feed = await verdict.discover({ signals: ["trending"], limit: 5 });
      const rows = (feed.signals.trending ?? []).map(
        (asset) =>
          `${asset.ticker ?? asset.asset_id}: ${asset.measure?.value ?? "?"} swaps, ` +
          `$${Math.round(asset.volume_1d_usd ?? 0).toLocaleString("en-US")} volume`,
      );
      return rows.length > 0 ? `Trending on Algorand:\n${rows.join("\n")}` : "Nothing to report.";
    }

    default: {
      if (command.startsWith("/")) return "Unknown command. Try /help.";
      const answer = await verdict.ask({ question: text });
      const used = answer.tools_used.map((tool) => tool.tool).join(", ");
      return used ? `${answer.answer}\n\n(from: ${used})` : answer.answer;
    }
  }
}

let offset = 0;
console.log(`Bot running. Paying from ${verdict.payerAddress ?? "(no wallet configured)"}`);

// Long-poll rather than webhooks so the example runs anywhere, no public URL needed.
for (;;) {
  try {
    const res = await fetch(`${api}/getUpdates?timeout=30&offset=${offset}`);
    const body = await res.json();
    for (const update of body.result ?? []) {
      offset = update.update_id + 1;
      const message = update.message;
      if (!message?.text) continue;
      try {
        await send(message.chat.id, await handle(message.text));
      } catch (err) {
        await send(
          message.chat.id,
          err instanceof PaymentNotConfiguredError
            ? "My wallet is not funded yet, so I cannot pay for that answer."
            : `That failed: ${err.message}`,
        );
      }
    }
  } catch (err) {
    console.error(`Poll failed, retrying: ${err.message}`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}
