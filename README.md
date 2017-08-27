# screepsmod-stats

## This adds game stats collection and HTTP endpoints to private Screeps servers

[![NPM info](https://nodei.co/npm/screepsmod-stats.png?downloads=true)](https://npmjs.org/package/screepsmod-stats)

Specifically, this mod enables screeps.com-style data collection to fuel the following APIs:
- /api/leaderboard/seasons
- /api/leaderboard/list
- /api/leaderboard/find
- /api/user/overview
- /api/user/stats
- /api/game/room-overview
- /api/game/map-stats
- /api/experimental/pvp
- /api/experimental/nukes

# Installation 

1. `npm install screepsmod-stats` in your server folder.
2. Thats it!

# Notes:
Steam client does not support viewing stats for private servers. This is meant for use by custom clients and external tooling.

Stats currently do not ever expire. If disk space is a concern, consider periodically clearing the stats collections.

This mod registers the "stats" and "leaderboard" features with the screepsmod-features mod, if present.