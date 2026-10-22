#!/usr/bin/env node
// Plumbing for security-review.yml. Prints counts only: findings must never reach job logs.

const crypto = require('crypto');
const fs = require('fs');
const nodePath = require('path');
const zlib = require('zlib');

const Sink = Object.freeze({
  CodeScanning: 'code-scanning',
  Issues: 'issues',
});

const Provider = Object.freeze({
  Anthropic: 'anthropic',
  OpenAI: 'openai',
});

const TOOL = 'ureview security review';
const LABEL = 'security-review';
const RULE_PREFIX = 'security-review/';
const FINGERPRINT_KEY = 'securityReview/v1';
const FINGERPRINT_MARKER = /<!-- security-review:fingerprint=([0-9a-f]{16}) -->/;
const LOCATION_MARKER = /\*\*Location:\*\* \[`([^`]+):(\d+)`\]/;
const RESOLVED_MARKER ='<!-- security-review:resolved -->';

const SEVERITY_SCORE = { critical: '9.5', high: '8.0', medium: '5.5', low: '3.0' };
const SEVERITY_LEVEL = { critical: 'error', high: 'error', medium: 'warning', low: 'note' };

const {
  BRANCH,
  GITHUB_API_URL,
  GITHUB_OUTPUT,
  GITHUB_SERVER_URL,
  GITHUB_TOKEN,
  HEAD_SHA,
  SINK,
  TARGET_REPOSITORY,
  WORK,
} = process.env;

const workPath = (...parts) => nodePath.join(WORK, ...parts);

function readJson(path) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  fs.mkdirSync(nodePath.dirname(path), { recursive: true });
  fs.writeFileSync(path, JSON.stringify(value, null, 2));
}

function readDirectory(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => readJson(nodePath.join(directory, name)))
    .filter((value) => value !== null);
}

function setOutput(name, value) {
  if (GITHUB_OUTPUT) {
    fs.appendFileSync(GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

function fingerprintOf(finding) {
  const key = [finding.cwe, finding.file, finding.symbol]
    .map((part) => String(part).trim().toLowerCase())
    .join('|');
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

async function github(method, path, body) {
  const response = await fetch(
    `${GITHUB_API_URL || 'https://api.github.com'}${path}`,
    {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${GITHUB_TOKEN}`,
        'x-github-api-version': '2022-11-28',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw Object.assign(
      new Error(`${method} ${path} returned ${response.status}`),
      { status: response.status },
    );
  }
  return response.status === 204 ? null : response.json();
}

async function paginate(path) {
  const items = [];
  const separator = path.includes('?') ? '&' : '?';
  for (let page = 1; ; page++) {
    const batch = await github(
      'GET',
      `${path}${separator}per_page=100&page=${page}`,
    );
    items.push(...batch);
    if (batch.length < 100) {
      return items;
    }
  }
}

async function alertsIn(state) {
  try {
    return await paginate(
      `/repos/${TARGET_REPOSITORY}/code-scanning/alerts?tool_name=${encodeURIComponent(TOOL)}&state=${state}`,
    );
  } catch (error) {
    switch (error.status) {
      case 404:
        return [];
      case 403:
        throw new Error(
          `Code scanning is not enabled for ${TARGET_REPOSITORY}, so findings have nowhere private to go. Enable code scanning, or pass sink: issues on a private repository.`,
        );
      default:
        throw error;
    }
  }
}

async function knownFromCodeScanning() {
  const known = [];
  for (const state of ['open', 'dismissed']) {
    const alerts = await alertsIn(state);
    for (const alert of alerts) {
      const location = alert.most_recent_instance?.location ?? {};
      known.push({
        fingerprint: alert.rule.id.slice(RULE_PREFIX.length),
        state,
        title: alert.rule.description,
        severity: alert.rule.security_severity_level,
        tags: alert.rule.tags ?? [],
        file: location.path,
        line: location.start_line,
        message: alert.most_recent_instance?.message?.text ?? '',
      });
    }
  }
  return known;
}

async function knownFromIssues() {
  const issues = await paginate(
    `/repos/${TARGET_REPOSITORY}/issues?labels=${LABEL}&state=all`,
  );
  return issues
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({ issue, match: FINGERPRINT_MARKER.exec(issue.body ?? '') }))
    .filter(({ match }) => match)
    .map(({ issue, match }) => {
      const location = LOCATION_MARKER.exec(issue.body) ?? [];
      return {
        fingerprint: match[1],
        state: issue.state,
        number: issue.number,
        title: issue.title,
        file: location[1] ?? '',
        line: Number(location[2] ?? 0),
      };
    });
}

async function known() {
  const entries =
    SINK === Sink.CodeScanning
      ? await knownFromCodeScanning()
      : await knownFromIssues();
  writeJson(workPath('known.json'), entries);
  const open = entries.filter((entry) => entry.state === 'open').length;
  console.log(`Tracked findings: ${entries.length} (${open} open).`);
}

function parseAreas(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const separator = line.indexOf(':');
      if (separator <= 0) {
        throw new Error(`Area '${line}' is not 'name: path path ...'.`);
      }
      return {
        name: line.slice(0, separator).trim(),
        paths: line
          .slice(separator + 1)
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((path) => path.replace(/\/+$/, '')),
      };
    });
}

function owns(area, file) {
  return area.paths.some(
    (path) => path === '.' || file === path || file.startsWith(`${path}/`),
  );
}

function trackedMarkdown(entries) {
  if (entries.length === 0) {
    return 'None yet.\n';
  }
  return entries
    .map(
      (entry) =>
        `- [${entry.state}] ${entry.title} (\`${entry.file}:${entry.line}\`, fingerprint ${entry.fingerprint})`,
    )
    .join('\n')
    .concat('\n');
}

function areas(specification) {
  const parsed = specification.trim() === '' ? [] : parseAreas(specification);
  const list =
    parsed.length > 0 ? parsed : [{ name: 'repository', paths: ['.'] }];
  const tracked = readJson(workPath('known.json')) ?? [];
  const assigned = list.map(() => []);
  for (const entry of tracked) {
    const index = list.findIndex((area) => owns(area, entry.file ?? ''));
    assigned[Math.max(0, index)].push(entry);
  }
  list.forEach((area, index) => {
    writeJson(workPath('areas', `${index}.json`), {
      ...area,
      known: assigned[index],
    });
    fs.writeFileSync(
      workPath('areas', `${index}.md`),
      trackedMarkdown(assigned[index]),
    );
  });
  writeJson(
    workPath('areas.json'),
    list.map((area, index) => ({ index, name: area.name })),
  );
  console.log(`Areas: ${list.length}.`);
}

function collect(provider, input, output, label, kind) {
  let value;
  if (provider === Provider.Anthropic) {
    const result = readJson(input);
    const cost = Number(result?.total_cost_usd ?? 0).toFixed(2);
    if (!result || result.is_error || !result.structured_output) {
      throw new Error(
        `${label} failed: ${result?.terminal_reason ?? 'no result'} after ${result?.num_turns ?? 0} turns ($${cost}).`,
      );
    }
    console.log(`${label}: ${result.num_turns} turns ($${cost}).`);
    value = result.structured_output;
  } else {
    value = readJson(input);
    if (!value) {
      throw new Error(`${label} produced no result.`);
    }
  }
  if (
    !Array.isArray(value.findings) ||
    (kind === 'triage' && !Array.isArray(value.resolved))
  ) {
    throw new Error(`${label} returned JSON that does not match the schema.`);
  }
  writeJson(output, { model: label, ...value });
  console.log(`${label}: ${value.findings.length} findings.`);
}

function candidates(directory, areaIndex) {
  const merged = [];
  for (const review of readDirectory(directory)) {
    for (const finding of review.findings) {
      merged.push({ reviewer: review.model, ...finding });
    }
  }
  const area = readJson(workPath('areas', `${areaIndex}.json`));
  writeJson(workPath('candidates.json'), merged);
  writeJson(workPath('known.json'), area.known);
  const open = area.known.filter((entry) => entry.state === 'open').length;
  console.log(`Candidates: ${merged.length}. Open tracked findings to recheck: ${open}.`);
  setOutput('triage', merged.length > 0 || open > 0);
}

function messageOf(finding) {
  return [
    finding.description,
    `Evidence: ${finding.evidence}`,
    `Impact: ${finding.impact}`,
    `Recommendation: ${finding.recommendation}`,
    `Reported by: ${finding.sources.join(', ')} (confidence ${finding.confidence}).`,
  ].join('\n\n');
}

function sarifRule(id, title, severity, tags) {
  return {
    id,
    name: id,
    shortDescription: { text: title },
    properties: {
      tags: [...new Set(['security', ...tags])],
      'security-severity': SEVERITY_SCORE[severity] ?? SEVERITY_SCORE.medium,
    },
  };
}

function sarifResult(id, severity, message, file, line, fingerprint) {
  return {
    ruleId: id,
    level: SEVERITY_LEVEL[severity] ?? SEVERITY_LEVEL.medium,
    message: { text: message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: file },
          region: { startLine: Math.max(1, line || 1) },
        },
      },
    ],
    partialFingerprints: { [FINGERPRINT_KEY]: fingerprint },
  };
}

async function publishCodeScanning(findings, resolved, tracked) {
  const rules = new Map();
  const results = [];
  const emitted = new Set();
  for (const finding of findings) {
    const fingerprint = finding.duplicateOf ?? fingerprintOf(finding);
    if (finding.duplicateOf || emitted.has(fingerprint)) {
      continue;
    }
    emitted.add(fingerprint);
    const id = `${RULE_PREFIX}${fingerprint}`;
    rules.set(
      id,
      sarifRule(id, finding.title, finding.severity, [finding.cwe.toLowerCase()]),
    );
    results.push(
      sarifResult(id, finding.severity, messageOf(finding), finding.file, finding.line, fingerprint),
    );
  }
  const created = results.length;
  let kept = 0;
  for (const entry of tracked) {
    if (
      emitted.has(entry.fingerprint) ||
      (entry.state === 'open' && resolved.has(entry.fingerprint))
    ) {
      continue;
    }
    emitted.add(entry.fingerprint);
    kept++;
    const id = `${RULE_PREFIX}${entry.fingerprint}`;
    rules.set(id, sarifRule(id, entry.title, entry.severity, entry.tags));
    results.push(
      sarifResult(id, entry.severity, entry.message, entry.file, entry.line, entry.fingerprint),
    );
  }
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: TOOL,
            informationUri: 'https://github.com/abnegate/claude-pr-owner',
            rules: [...rules.values()],
          },
        },
        automationDetails: { id: 'security-review/' },
        results,
      },
    ],
  };
  fs.writeFileSync(workPath('security-review.sarif'), JSON.stringify(sarif));
  const closed = tracked.filter(
    (entry) => entry.state === 'open' && resolved.has(entry.fingerprint),
  ).length;
  console.log(`New alerts: ${created}. Kept: ${kept}. Resolved: ${closed}.`);
  if (created === 0 && closed === 0) {
    return;
  }
  await github('POST', `/repos/${TARGET_REPOSITORY}/code-scanning/sarifs`, {
    commit_sha: HEAD_SHA,
    ref: `refs/heads/${BRANCH}`,
    sarif: zlib.gzipSync(JSON.stringify(sarif)).toString('base64'),
  });
  console.log('Uploaded the code scanning analysis.');
}

function issueBody(finding, fingerprint) {
  const location = `${GITHUB_SERVER_URL}/${TARGET_REPOSITORY}/blob/${HEAD_SHA}/${finding.file}#L${finding.line}`;
  return [
    `**Severity:** ${finding.severity} · **Confidence:** ${finding.confidence} · **${finding.cwe}** · **Reported by:** ${finding.sources.join(', ')}`,
    `**Location:** [\`${finding.file}:${finding.line}\`](${location}) in \`${finding.symbol}\``,
    '### Description',
    finding.description,
    '### Evidence',
    finding.evidence,
    '### Impact',
    finding.impact,
    '### Recommendation',
    finding.recommendation,
    `<!-- security-review:fingerprint=${fingerprint} -->`,
  ].join('\n\n');
}

async function publishIssues(findings, resolved, tracked) {
  const seen = new Set(tracked.map((entry) => entry.fingerprint));
  let created = 0;
  for (const finding of findings) {
    const fingerprint = finding.duplicateOf ?? fingerprintOf(finding);
    if (finding.duplicateOf || seen.has(fingerprint)) {
      continue;
    }
    seen.add(fingerprint);
    await github('POST', `/repos/${TARGET_REPOSITORY}/issues`, {
      title: `[${finding.severity}] ${finding.title}`,
      body: issueBody(finding, fingerprint),
      labels: [LABEL],
    });
    created++;
  }
  let flagged = 0;
  const fixed = tracked.filter(
    (entry) => entry.state === 'open' && resolved.has(entry.fingerprint),
  );
  for (const entry of fixed) {
    const comments = await paginate(
      `/repos/${TARGET_REPOSITORY}/issues/${entry.number}/comments`,
    );
    if (comments.some((comment) => comment.body?.includes(RESOLVED_MARKER))) {
      continue;
    }
    await github(
      'POST',
      `/repos/${TARGET_REPOSITORY}/issues/${entry.number}/comments`,
      {
        body: `The security review no longer finds this defect at ${HEAD_SHA}. Close this issue once confirmed.\n\n${RESOLVED_MARKER}`,
      },
    );
    flagged++;
  }
  console.log(`New issues: ${created}. Flagged as resolved: ${flagged}.`);
}

async function publish(directory) {
  const triages = readDirectory(directory);
  const findings = triages.flatMap((triage) => triage.findings);
  const resolved = new Set(triages.flatMap((triage) => triage.resolved));
  for (const finding of findings) {
    resolved.delete(finding.duplicateOf);
  }
  const tracked = readJson(workPath('known.json')) ?? [];
  console.log(`Confirmed findings: ${findings.length} from ${triages.length} triage runs.`);
  if (SINK === Sink.CodeScanning) {
    await publishCodeScanning(findings, resolved, tracked);
    return;
  }
  await publishIssues(findings, resolved, tracked);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!WORK) {
    throw new Error('WORK must be set.');
  }
  switch (command) {
    case 'known':
    case 'publish':
      if (!Object.values(Sink).includes(SINK) || !TARGET_REPOSITORY) {
        throw new Error(
          `SINK must be one of ${Object.values(Sink).join(', ')}, and TARGET_REPOSITORY must be set.`,
        );
      }
      return command === 'known' ? known() : publish(rest[0]);
    case 'areas':
      return areas(fs.readFileSync(rest[0], 'utf8'));
    case 'collect':
      return collect(...rest);
    case 'candidates':
      return candidates(...rest);
    default:
      throw new Error(`Unknown command '${command}'.`);
  }
}

main().catch((error) => {
  console.log(`::error::${error.message}`);
  process.exit(1);
});
