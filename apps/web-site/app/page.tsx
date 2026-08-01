import { headers } from "next/headers";
import Workbench from "./workbench";

export default async function Home() {
  const requestHeaders = await headers();
  const email = requestHeaders.get("oai-authenticated-user-email") || "当前 B 账号";
  const encodedName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName = encodedName && requestHeaders.get("oai-authenticated-user-full-name-encoding") === "percent-encoded-utf-8"
    ? decodeURIComponent(encodedName) : encodedName;
  return <Workbench owner={fullName || email} />;
}
