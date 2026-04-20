import { createRequester, type TokenProvider } from "./base";
import type { CurrentUserResponse } from "./types";

export class AuthApi {
  private readonly request: ReturnType<typeof createRequester>;

  constructor(getToken: TokenProvider) {
    this.request = createRequester(getToken);
  }

  me() {
    return this.request<CurrentUserResponse>("/auth/me");
  }
}

