export type TelegramBindingScope = "all" | "bound" | "unbound" | "changed" | "other";

export type TelegramBindingSearchSource = {
  name: string;
  username: string;
  external_chat_id: string;
  chat_type: string;
};

export type TelegramBindingState = {
  before: boolean;
  after: boolean;
  hasOtherBindings: boolean;
};

export function matchesTelegramBindingSearch(source: TelegramBindingSearchSource, search: string) {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return true;
  const username = source.username.replace(/^@/, "");
  return `${source.name} ${username} @${username} ${source.external_chat_id} ${source.chat_type}`
    .toLocaleLowerCase()
    .includes(query);
}

export function matchesTelegramBindingScope(scope: TelegramBindingScope, state: TelegramBindingState) {
  if (scope === "bound") return state.after;
  if (scope === "unbound") return !state.after;
  if (scope === "changed") return state.before !== state.after;
  if (scope === "other") return state.hasOtherBindings;
  return true;
}
