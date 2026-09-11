/**
 * Jewel OS - workspace provider adapters.
 *
 * Deliberately narrow. Each adapter exposes only the operations Jewel's tools
 * actually need, so a compromised prompt cannot reach a capability that was
 * never built. Broad "call any endpoint" adapters are how assistants end up
 * doing things nobody designed for.
 *
 * Every adapter follows the same contract:
 *   - constructed with a credential, or reports `configured: false`
 *   - an unconfigured adapter THROWS on use rather than returning empty data,
 *     because "no results" and "not connected" must never look the same (INV-6)
 *   - all reads return provenance so the memory vault can cite them
 *   - all writes are the caller's responsibility to gate; adapters do not
 *     self-approve
 */
import { HttpClient } from './http.js';
import { ProviderError, ValidationError } from '../core/errors.js';

class BaseAdapter {
  constructor(name, configured) { this.name = name; this.configured = configured; }
  _assert() {
    if (!this.configured) {
      throw new ProviderError(
        `${this.name} is not connected. Jewel cannot answer from it, and will not guess. Add the credential and re-run \`jewel doctor\`.`,
        { provider: this.name, configured: false },
      );
    }
  }
}

/** Notion - source of truth for memory, tasks, approvals and project status. */
export class NotionAdapter extends BaseAdapter {
  constructor({ apiKey, audit, fetchImpl } = {}) {
    super('Notion', !!apiKey);
    if (apiKey) {
      this.http = new HttpClient({
        baseUrl: 'https://api.notion.com', provider: 'notion',
        auth: { type: 'bearer', value: apiKey },
        defaultHeaders: { 'Notion-Version': '2022-06-28' },
        audit, fetchImpl,
      });
    }
  }

  /** @param {{ query:string, pageSize?:number }} q */
  async search({ query, pageSize = 10 }) {
    this._assert();
    const data = await this.http.request('POST', '/v1/search',
      { body: { query, page_size: Math.min(pageSize, 50) }, retryable: true });
    return (data?.results ?? []).map((r) => ({
      sourceId: `notion:${r.id}`,
      sourceRevision: r.last_edited_time ?? null,
      locator: r.url ?? null,
      title: titleOf(r),
      type: r.object,
      raw: r,
    }));
  }

  async getPage(pageId) {
    this._assert();
    if (!pageId) throw new ValidationError('pageId is required');
    const page = await this.http.get(`/v1/pages/${pageId}`);
    const blocks = await this.http.get(`/v1/blocks/${pageId}/children`, { query: { page_size: 100 } });
    return {
      sourceId: `notion:${pageId}`,
      sourceRevision: page?.last_edited_time ?? null,
      locator: page?.url ?? null,
      title: titleOf(page),
      text: (blocks?.results ?? []).map(blockText).filter(Boolean).join('\n'),
    };
  }

  /** Append a block to a page. Caller must gate this. */
  async appendText(pageId, text) {
    this._assert();
    return this.http.patch(`/v1/blocks/${pageId}/children`, {
      children: [{ object: 'block', type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: String(text).slice(0, 1900) } }] } }],
    });
  }
}

function titleOf(obj) {
  const props = obj?.properties ?? {};
  for (const v of Object.values(props)) {
    if (v?.type === 'title') return (v.title ?? []).map((t) => t.plain_text).join('') || 'Untitled';
  }
  return obj?.title?.map?.((t) => t.plain_text).join('') || 'Untitled';
}

function blockText(b) {
  const body = b?.[b?.type];
  const rich = body?.rich_text ?? [];
  return rich.map((t) => t.plain_text).join('');
}

/** Google - Gmail, Calendar and Drive over one OAuth credential. */
export class GoogleAdapter extends BaseAdapter {
  constructor({ accessToken, audit, fetchImpl } = {}) {
    super('Google', !!accessToken);
    if (accessToken) {
      const auth = { type: 'bearer', value: accessToken };
      this.gmail = new HttpClient({ baseUrl: 'https://gmail.googleapis.com', provider: 'gmail', auth, audit, fetchImpl });
      this.calendar = new HttpClient({ baseUrl: 'https://www.googleapis.com', provider: 'gcal', auth, audit, fetchImpl });
      this.drive = new HttpClient({ baseUrl: 'https://www.googleapis.com', provider: 'gdrive', auth, audit, fetchImpl });
    }
  }

  async listThreads({ query = '', max = 10 } = {}) {
    this._assert();
    const data = await this.gmail.get('/gmail/v1/users/me/threads', { query: { q: query, maxResults: Math.min(max, 25) } });
    return (data?.threads ?? []).map((t) => ({ sourceId: `gmail:${t.id}`, snippet: t.snippet ?? '', threadId: t.id }));
  }

  async getMessage(id) {
    this._assert();
    const m = await this.gmail.get(`/gmail/v1/users/me/messages/${id}`, { query: { format: 'metadata' } });
    const headers = Object.fromEntries((m?.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]));
    return {
      sourceId: `gmail:${id}`, sourceRevision: m?.historyId ?? null,
      from: headers.from ?? null, to: headers.to ?? null,
      subject: headers.subject ?? null, date: headers.date ?? null,
      snippet: m?.snippet ?? '',
    };
  }

  /** Create a DRAFT. Jewel drafts freely; only sending is gated. */
  async createDraft({ to, subject, body, from }) {
    this._assert();
    const raw = Buffer.from(
      [`From: ${from}`, `To: ${to.join(', ')}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=UTF-8', '', body].join('\r\n'),
    ).toString('base64url');
    const d = await this.gmail.post('/gmail/v1/users/me/drafts', { message: { raw } });
    return { draftId: d?.id ?? null, messageId: d?.message?.id ?? null };
  }

  /** Send. MUST be gated by the caller - this adapter does not check. */
  async sendDraft(draftId) {
    this._assert();
    const sent = await this.gmail.post('/gmail/v1/users/me/drafts/send', { id: draftId });
    return { messageId: sent?.id ?? null, threadId: sent?.threadId ?? null };
  }

  async listEvents({ calendarId = 'primary', timeMin, timeMax, max = 20 }) {
    this._assert();
    const data = await this.calendar.get(`/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
      query: { timeMin, timeMax, singleEvents: true, orderBy: 'startTime', maxResults: Math.min(max, 50) },
    });
    return (data?.items ?? []).map((e) => ({
      sourceId: `gcal:${e.id}`, summary: e.summary ?? '(no title)',
      start: e.start?.dateTime ?? e.start?.date ?? null,
      end: e.end?.dateTime ?? e.end?.date ?? null,
      attendees: (e.attendees ?? []).map((a) => a.email),
      status: e.status,
    }));
  }

  /**
   * Availability check. Re-run immediately before any event write - the
   * README requires it, and a stale check is how double-bookings happen.
   */
  async freeBusy({ calendarId = 'primary', timeMin, timeMax }) {
    this._assert();
    const data = await this.calendar.post('/calendar/v3/freeBusy', {
      timeMin, timeMax, items: [{ id: calendarId }],
    }, { retryable: true });
    const busy = data?.calendars?.[calendarId]?.busy ?? [];
    return { busy, free: busy.length === 0, checkedAt: new Date().toISOString() };
  }

  /** Create an event. MUST be gated, and availability re-checked, by the caller. */
  async createEvent({ calendarId = 'primary', summary, start, end, timezone, attendees = [] }) {
    this._assert();
    const e = await this.calendar.post(`/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
      summary,
      start: { dateTime: start, timeZone: timezone },
      end: { dateTime: end, timeZone: timezone },
      attendees: attendees.map((email) => ({ email })),
    });
    return { eventId: e?.id ?? null, htmlLink: e?.htmlLink ?? null, status: e?.status ?? null };
  }

  async searchDrive({ query, max = 10 }) {
    this._assert();
    const data = await this.drive.get('/drive/v3/files', {
      query: { q: `name contains '${String(query).replace(/'/g, "\\'")}' and trashed = false`,
        pageSize: Math.min(max, 50), fields: 'files(id,name,mimeType,modifiedTime,webViewLink)' },
    });
    return (data?.files ?? []).map((f) => ({
      sourceId: `drive:${f.id}`, sourceRevision: f.modifiedTime ?? null,
      name: f.name, mimeType: f.mimeType, locator: f.webViewLink ?? null,
    }));
  }
}

/** GitHub - code only. Never the store for private documents. */
export class GitHubAdapter extends BaseAdapter {
  constructor({ token, audit, fetchImpl } = {}) {
    super('GitHub', !!token);
    if (token) {
      this.http = new HttpClient({
        baseUrl: 'https://api.github.com', provider: 'github',
        auth: { type: 'bearer', value: token },
        defaultHeaders: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
        audit, fetchImpl,
      });
    }
  }

  async listRepos({ max = 20 } = {}) {
    this._assert();
    const data = await this.http.get('/user/repos', { query: { per_page: Math.min(max, 100), sort: 'pushed' } });
    return (data ?? []).map((r) => ({
      sourceId: `github:${r.full_name}`, name: r.full_name, private: r.private,
      pushedAt: r.pushed_at, openIssues: r.open_issues_count, locator: r.html_url,
    }));
  }

  async listPulls({ owner, repo, state = 'open' }) {
    this._assert();
    const data = await this.http.get(`/repos/${owner}/${repo}/pulls`, { query: { state, per_page: 30 } });
    return (data ?? []).map((p) => ({
      sourceId: `github:pr:${owner}/${repo}#${p.number}`, number: p.number, title: p.title,
      author: p.user?.login, draft: p.draft, updatedAt: p.updated_at, locator: p.html_url,
    }));
  }
}

/** Build every adapter from config in one place. */
export function createWorkspace(cfg = {}, deps = {}) {
  return {
    notion: new NotionAdapter({ apiKey: cfg.notionApiKey, ...deps }),
    google: new GoogleAdapter({ accessToken: cfg.googleAccessToken, ...deps }),
    github: new GitHubAdapter({ token: cfg.githubToken, ...deps }),
  };
}
