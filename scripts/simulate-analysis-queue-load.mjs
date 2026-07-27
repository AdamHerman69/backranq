#!/usr/bin/env node

const users = Number(process.argv[2] ?? 1000);
const jobsPerUser = Number(process.argv[3] ?? 50);
const globalLimit = Number(process.argv[4] ?? 1000);
const perUserLimit = Number(process.argv[5] ?? 1);

const started = performance.now();
const selected = [];
const skipped = { perUserLimit: 0 };

for (let userIndex = 0; userIndex < users; userIndex += 1) {
    const allowed = Math.min(jobsPerUser, perUserLimit);
    for (let jobIndex = 0; jobIndex < jobsPerUser; jobIndex += 1) {
        if (selected.length >= globalLimit) break;
        if (jobIndex < allowed) {
            selected.push(`user-${userIndex}:job-${jobIndex}`);
        } else {
            skipped.perUserLimit += 1;
        }
    }
    if (selected.length >= globalLimit) break;
}

const selectedUsers = new Set(selected.map((id) => id.split(':')[0]));
const durationMs = Math.round(performance.now() - started);
const expected = Math.min(users, globalLimit);
const ok = selected.length === expected && selectedUsers.size === selected.length;

console.log(
    JSON.stringify(
        {
            ok,
            users,
            jobsPerUser,
            globalLimit,
            perUserLimit,
            selected: selected.length,
            selectedUsers: selectedUsers.size,
            skipped,
            durationMs,
        },
        null,
        2
    )
);

if (!ok) process.exit(1);
