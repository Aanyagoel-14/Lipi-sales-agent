import { currentContext, type CookieMutation } from "./context";

/** The slice of Next's cookie store this codebase actually uses. */
class CookieJar {
  get(name: string) {
    const value = currentContext().cookies.get(name);
    return value === undefined ? undefined : { name, value };
  }

  set(name: string, value: string, options: CookieMutation["options"] = {}) {
    const ctx = currentContext();
    ctx.cookies.set(name, value);
    ctx.setCookies.push({ name, value, options });
  }

  delete(name: string) {
    const ctx = currentContext();
    ctx.cookies.delete(name);
    ctx.setCookies.push({ name, value: "", options: { path: "/", expires: new Date(0) } });
  }
}

export async function cookies() {
  return new CookieJar();
}

export async function headers() {
  return currentContext().headers;
}
