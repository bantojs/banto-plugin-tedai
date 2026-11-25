/**
 * 生の TCP 接続（SMTP でメールを送るためだけ）。Workers は cloudflare:sockets（src/adapters/workers/socket.ts）、
 * Node なら node:net / node:tls で実装する。形は Banto の src/adapters/types.ts と同じ。
 */
export interface RawConnection {
  /** 次のデータ。接続が閉じたら null */
  read(): Promise<Uint8Array | null>;
  write(data: Uint8Array): Promise<void>;
  /** STARTTLS: この接続を TLS にして返す。以後は返った接続だけを使う */
  startTls(): Promise<RawConnection>;
  close(): Promise<void>;
}

export interface SocketAdapter {
  /** tls: "on" は最初から TLS（465）、"starttls" は平文で開いてあとで startTls()（587）、"off" は平文のまま */
  connect(host: string, port: number, tls: "on" | "off" | "starttls"): Promise<RawConnection>;
}
