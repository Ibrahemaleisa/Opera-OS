import net from "node:net";

/**
 * A minimal in-process SMTP server for tests (no dependency): enough of RFC 5321 for nodemailer's
 * SMTP transport. `rcptReply` decides the answer to each RCPT TO, so tests can script transient
 * (4xx) and permanent (5xx) failures; accepted messages are captured raw.
 */
export interface CapturedMail {
  from: string;
  to: string[];
  raw: string;
}

export interface SmtpStub {
  url: string;
  messages: CapturedMail[];
  /** reply for the next RCPT TO; default "250 OK" */
  rcptReply: (to: string) => string;
  close(): Promise<void>;
}

export async function startSmtpStub(): Promise<SmtpStub> {
  const messages: CapturedMail[] = [];
  const sockets = new Set<net.Socket>();
  const stub: SmtpStub = { url: "", messages, rcptReply: () => "250 2.1.5 OK", close: async () => undefined };
  let seq = 0;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    let inData = false;
    let data = "";
    let env: { from: string; to: string[] } = { from: "", to: [] };
    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply("220 stub.local ESMTP test");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) {
            data += buffer;
            buffer = "";
            return;
          }
          data += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          messages.push({ ...env, raw: data });
          data = "";
          reply(`250 2.0.0 OK queued as stub-${++seq}`);
          continue;
        }
        const nl = buffer.indexOf("\r\n");
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") reply("250-stub.local\r\n250 8BITMIME");
        else if (cmd === "MAIL") {
          env = { from: line.replace(/^MAIL FROM:\s*/i, "").replace(/[<>]/g, "").split(" ")[0], to: [] };
          reply("250 2.1.0 OK");
        } else if (cmd === "RCPT") {
          const to = line.replace(/^RCPT TO:\s*/i, "").replace(/[<>]/g, "").split(" ")[0];
          const r = stub.rcptReply(to);
          if (r.startsWith("2")) env.to.push(to);
          reply(r);
        } else if (cmd === "DATA") {
          inData = true;
          reply("354 End data with <CR><LF>.<CR><LF>");
        } else if (cmd === "RSET") {
          env = { from: "", to: [] };
          reply("250 OK");
        } else if (cmd === "NOOP") reply("250 OK");
        else if (cmd === "QUIT") {
          reply("221 Bye");
          socket.end();
        } else reply("502 Command not implemented");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  stub.url = `smtp://127.0.0.1:${port}`;
  stub.close = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
  return stub;
}
