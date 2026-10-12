#!/usr/bin/env python3
"""One-line metrics footer for a JARVIS report, run inside a cloud session.

Usage: python3 session_metrics.py [--since <ISO time JARVIS sent the message>]

Reads this session's transcript (the most recently written one under ~/.claude/projects) and
prints e.g. "⏱ 4m12s since your message · 🔢 1.84M tokens (31k output) over 22 replies · context 85k".
Token counting follows claude-workflow's session_tokens.py: each API reply counted once; cache
re-reads are most of the total because every reply re-reads the whole context.
"""
import argparse
import glob
import json
import os
from datetime import datetime, timezone


def latest_transcript():
    files = glob.glob(os.path.expanduser('~/.claude/projects/*/*.jsonl'))
    return max(files, key=os.path.getmtime) if files else None


def tally(path):
    seen = set()
    total = output = replies = context = 0
    with open(path) as f:
        for line in f:
            try:
                message = json.loads(line).get('message')
            except ValueError:
                continue
            if not isinstance(message, dict) or not message.get('usage') or message.get('id') in seen:
                continue
            seen.add(message.get('id'))
            u = message['usage']
            context = (u.get('cache_read_input_tokens', 0) + u.get('cache_creation_input_tokens', 0)
                       + u.get('input_tokens', 0))
            total += context + u.get('output_tokens', 0)
            output += u.get('output_tokens', 0)
            replies += 1
    return total, output, replies, context


def human(n):
    return f'{n / 1e6:.2f}M' if n >= 1e6 else f'{round(n / 1e3)}k'


def duration(seconds):
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    return f'{h}h{m:02d}m' if h else f'{m}m{s:02d}s'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--since')
    args = parser.parse_args()
    parts = []
    if args.since:
        try:
            sent = datetime.fromisoformat(args.since.replace('Z', '+00:00'))
            parts.append(f'⏱ {duration((datetime.now(timezone.utc) - sent).total_seconds())} since your message')
        except ValueError:
            pass
    path = latest_transcript()
    if path:
        total, output, replies, context = tally(path)
        parts.append(f'🔢 {human(total)} tokens ({human(output)} output) over {replies} replies')
        parts.append(f'context {human(context)}')
    print(' · '.join(parts))


if __name__ == '__main__':
    main()
