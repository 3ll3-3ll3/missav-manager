export type UiError = { summary: string; detail?: string };

export function toUiError(error: unknown, fallback = "操作失败"): UiError {
  const technical = error instanceof Error ? error.message : String(error || "");
  if (/Failed to fetch|NetworkError|Load failed|fetch failed/i.test(technical)) {
    return { summary: "网络请求失败，请检查连接后重试", detail: technical };
  }
  if (/timeout|超时|AbortError/i.test(technical)) {
    return { summary: "请求超时，请稍后重试", detail: technical };
  }
  return { summary: technical || fallback };
}

export default function ErrorNotice({
  error,
  retry,
  action,
}: {
  error: UiError;
  retry?: () => void;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="notice error-notice" role="alert">
      <div className="error-notice-heading">
        <strong>{error.summary}</strong>
        <div className="button-row">
          {action && <button onClick={action.onClick}>{action.label}</button>}
          {retry && <button onClick={retry}>刷新重试</button>}
        </div>
      </div>
      {error.detail && error.detail !== error.summary && (
        <details>
          <summary>查看脱敏技术详情</summary>
          <pre>{error.detail}</pre>
        </details>
      )}
    </div>
  );
}
