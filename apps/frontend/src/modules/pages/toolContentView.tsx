import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import mermaid from 'mermaid';
import type { ToolStructuredContent } from '../../agent/types.js';

/** 按 content.format 渲染工具返回的结构化内容（结构化报告格式规范 §6.4）。 */
export function ToolContentView({ content }: { content: ToolStructuredContent }): JSX.Element {
  switch (content.format) {
    case 'mermaid':
      return <MermaidBlock code={content.code} />;
    case 'json_subtitles':
      return <SubtitlesTable entries={content.entries} />;
    case 'scenes':
      return <ScenesTable scenes={content.scenes} />;
    case 'silence':
      return <SilenceList silences={content.silences} totalSilenceMs={content.totalSilenceMs} />;
    case 'search_results':
      return <SearchResultsList keyword={content.keyword} results={content.results} />;
    case 'markdown':
      return <ReactMarkdown>{content.text}</ReactMarkdown>;
    case 'json':
      return <pre className="tool-content-json">{JSON.stringify(content.data, null, 2)}</pre>;
    default:
      return <pre className="tool-content-json">{JSON.stringify(content, null, 2)}</pre>;
  }
}

// ── Mermaid ──

let mermaidReady = false;

function MermaidBlock({ code }: { code: string }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!mermaidReady) {
      mermaid.initialize({ startOnLoad: false, theme: 'neutral' });
      mermaidReady = true;
    }
    let cancelled = false;
    const id = `mmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    mermaid
      .render(id, code)
      .then(({ svg }) => {
        if (!cancelled && ref.current) ref.current.innerHTML = svg;
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (failed) {
    // 语法错误等：回退为代码块展示
    return <pre className="tool-content-json">{code}</pre>;
  }
  return <div className="mermaid-block" ref={ref} />;
}

// ── 各格式渲染 ──

function msToHms(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function SubtitlesTable({ entries }: { entries: Array<{ i: number; p: string; t: string; y: string }> }): JSX.Element {
  return (
    <div className="tool-content-table-wrap">
      <table className="tool-content-table">
        <thead>
          <tr><th>#</th><th>开始</th><th>结束</th><th>字幕</th></tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.i}>
              <td>{e.i + 1}</td>
              <td>{e.p}</td>
              <td>{e.t}</td>
              <td>{e.y}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ScenesTable({ scenes }: { scenes: Array<{ index: number; startMs: number; endMs: number; durationMs: number }> }): JSX.Element {
  return (
    <div className="tool-content-table-wrap">
      <table className="tool-content-table">
        <thead>
          <tr><th>场景</th><th>开始</th><th>结束</th><th>时长</th></tr>
        </thead>
        <tbody>
          {scenes.map((s) => (
            <tr key={s.index}>
              <td>{s.index}</td>
              <td>{msToHms(s.startMs)}</td>
              <td>{msToHms(s.endMs)}</td>
              <td>{(s.durationMs / 1000).toFixed(1)}s</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SilenceList({ silences, totalSilenceMs }: { silences: Array<{ startMs: number; endMs: number; durationMs: number }>; totalSilenceMs?: number }): JSX.Element {
  return (
    <div>
      <ul className="tool-content-list">
        {silences.map((s, i) => (
          <li key={i}>
            {msToHms(s.startMs)} - {msToHms(s.endMs)}（{(s.durationMs / 1000).toFixed(1)}s）
          </li>
        ))}
      </ul>
      {typeof totalSilenceMs === 'number' && (
        <div className="analysis-step-detail">总静音时长 {(totalSilenceMs / 1000).toFixed(1)} 秒</div>
      )}
    </div>
  );
}

function SearchResultsList({ keyword, results }: { keyword: string; results: Array<{ matchIndex: number; start: string; end: string; before: string; match: string; after: string }> }): JSX.Element {
  if (!results.length) {
    return <div className="analysis-step-detail">关键词「{keyword}」无匹配</div>;
  }
  return (
    <ul className="tool-content-list">
      {results.map((r) => (
        <li key={r.matchIndex}>
          <span className="analysis-step-detail">{r.start} - {r.end}</span> {r.before}
          <mark>{r.match}</mark>
          {r.after}
        </li>
      ))}
    </ul>
  );
}
