const _ = require('lodash');
const express = require('express');
const bodyParser = require("body-parser");
const q = require("q");

module.exports = function (config, statsMod) {
    var storage = config.common.storage;

    config.backend.on('expressPreConfig', function (app) {
        app.use(bodyParser.json());

        // /api/leaderboard/seasons
        // /api/leaderboard/list
        // /api/leaderboard/find
        app.use('/api/leaderboard', serveLeaderboard());

        // /api/user/overview
        // /api/user/stats
        app.use('/api/user', serveUserStats());

        // /api/game/room-overview
        // /api/game/map-stats
        app.use('/api/game', serveGameStats());
    });
    
    function serveLeaderboard() {
        var router = new express.Router();
        
        router.get('/list', (req, res) => {
            var { limit, season, offset, mode } = req.query;
            if (limit > 20 || limit < 0 || !_.has(statsMod.leaderboards, mode)) {
                res.send({ error: "invalid params" });
                return;
            }

            var collection = storage.db[`leaderboard.${mode}`];
            collection.count({ season }).then((count) => {
                collection.findEx({ season }, {sort: { rank: 1 }, limit, skip: offset }).then(leaderEntries => {
                    let unknownUserIds = [];
                    let list = [];
                    for (let index in leaderEntries) {
                        list.push(_.pick(leaderEntries[index], ['_id','season', 'score', 'user', 'rank']));
                        unknownUserIds.push(leaderEntries[index].user);
                    }

                    storage.db.users.find({ _id: { $in: unknownUserIds } }).then((unknownUsers) => {
                        let users = _.reduce(unknownUsers, (result, user) => {
                            result[user._id.toString()] = _.pick(user, [ "_id", "username", "badge", "gcl" ]);
                            return result;
                        }, {});
                        
                        res.send({ ok: 1, count, list, users });
                    });
                });
            });
        });

        router.get('/find', (req, res) => {
            var { username, mode, season } = req.query;
            if (!mode || !username) {
                res.send({ error: "invalid params" });
                return;
            }

            if (season) {
                storage.db[`leaderboard.${mode}`].findOne({ season, username }).then(data => {
                    let obj = _.pick(data, ['_id','season', 'score', 'user', 'rank']);
                    obj.ok = 1;

                    res.send(obj);
                });
            } else {
                storage.db.users.findOne({ username }).then((user) => {
                    storage.db[`leaderboard.${mode}`].find({ user: user._id }).then(data => {
                        res.send({
                            ok: 1,
                            list: _.map(data, (obj) => _.pick(obj, ['_id','season', 'score', 'user', 'rank']))
                        });
                    });
                });
            }
        });

        router.get('/seasons', (req, res) => {
            storage.db["leaderboard.seasons"].find().then(data => {
                let seasons = _.map(data, (obj) => _.pick(obj, ['_id','name','date']));
                if (seasons.length === 1) {
                    // frontend crashes if there's only one season
                    seasons.push({ _id: "fake", name: "Didn't Happen", date: new Date().toISOString() });
                }

                res.send({
                    ok: 1,
                    seasons
                });
            });
        });

        return router;
    }

    function serveUserStats() {
        var router = new express.Router();
        router.get('/stats', (req, res) => {
            var { interval, id } = req.query;

            if (!_.has(statsMod.statIntervals, interval)) {
                res.send({ error: "invalid params" });
                return;
            }
            
            var blocks = statsMod.statIntervals[interval];
            var intervalDuration = 60 * 1000 * interval;
            var endTime = Math.floor(Date.now() / intervalDuration);
            var blockStart = endTime - blocks + 1;

            var stats = {};
            storage.db['rooms.stats' + interval].find({ $and: [{ endTime: { $gte: blockStart } }, { user: id }]})
            .then((rawStats) => {
                var roomUserSums = {};
                for (var statObj of rawStats) {
                    for (var statName of statsMod.statNames) {
                        stats[statName] = (stats[statName] || 0) + (statObj[statName] || 0);
                    }
                }

                res.send({
                    ok: 1,
                    stats
                });
            });
        });

        return router;
    }

    function serveGameStats() {
        var router = new express.Router();
        var db = storage.db;
        
        // api/game/room-overview?room=<roomName>&interval=<minutes per chunk>
        router.get('/room-overview', (req, res) => {
            var interval = parseInt(req.query.interval) || 8;
            if (!_.has(statsMod.statIntervals, interval)) {
                res.send({ error: "invalid params" });
                return;
            }

            var room = req.query.room;
            var blocks = statsMod.statIntervals[interval];
            var intervalDuration = 60 * 1000 * interval;

            var owner = null;
            var stats = {};
            var statsMax = {};
            var totals = {};

            // can't lock query to endtime or we'll get problems with the day-long query
            var endTime = Math.floor(Date.now() / intervalDuration);
            var blockStart = endTime - blocks + 1;
            // get the room's current owner
            db['rooms.objects'].findOne({ type: "controller", room }).then((controller) => {
                if (controller && controller.user) {
                    return db.users.findOne({ _id: controller.user }).then((user) => {
                        owner = _.pick(user, [ 'username', 'badge' ]);
                    })
                    .then(() => db[`rooms.stats${interval}`].findEx({ $and: [{ user: controller.user }, { room }, { endTime: { $gte: blockStart } }] }, {sort: { endTime: -1 }}))
                    .then((rawStats) => {
                        for (var statName of statsMod.statNames) {
                            stats[statName] = [];
                            totals[statName] = 0;
                            for (var i = 0; i < blocks; i++) {
                                stats[statName].push({ endTime: endTime + i, value: 0 });
                            }
                        }

                        for (var rawStat of rawStats) {
                            for (var statName of statsMod.statNames) {
                                var val = rawStat[statName] || 0;
                                stats[statName][rawStat.endTime - blockStart].value += val;
                                totals[statName] += val;
                            }
                        }
                    })
                } else {
                    return q.when();
                }
            }).then(() => {
                var now = Date.now();
                return db["rooms.stats.max"].find().then((results) => {
                    var intervalStart = {};
                    for (var interval in statsMod.statIntervals) {
                        intervalStart[interval] = Math.floor(now / (interval * 60 * 1000)) - statsMod.statIntervals[interval] + 1;
                    }

                    for (var statName of statsMod.statNames) {
                        for (var interval in statsMod.statIntervals) {
                            statsMax[statName + interval] = 0;
                        }
                    }

                    for (var result of results) {
                        if (results.endTime < intervalStart[result.interval]) continue;

                        for (var statName of statsMod.statNames) {
                            if (result[statName] && result[statName] > statsMax[statName + result.interval]) {
                                statsMax[statName + result.interval] = result[statName];
                            }
                        }
                    }
                });
            }).then(() => {
                res.send({ ok: 1, owner, stats, statsMax, totals })
            });
        });

        router.post('/map-stats', (req, res) => {
            // console.log("StatsMod /api/game/map-stats")
            if (!_.isArray(req.body.rooms)) {
                res.send({ error: 'invalid params'});
                return;
            }

            var match = req.body.statName.match(/^(.*?)(\d+)$/);
            if (!match) {
                res.send({ error: 'invalid params'});
                return;
            }

            var statKey = req.body.statName;
            var [,statName,interval] = match;
            var blocks = statsMod.statIntervals[interval];
            var intervalDuration = 60 * 1000 * interval;
            var endTime = Math.floor(Date.now() / intervalDuration);

            // console.log(endTime, statKey, statName, interval)

            var stats = {};
            var users = {};
            var gameTime;
            var statsMax;
            var debug = {};

            return storage.env.get(storage.env.keys.GAMETIME)
            .then((data) => {
                gameTime = data;
                return db.rooms.find({_id: {$in: req.body.rooms}})
            })
            .then((data) => {
                data.forEach((i) => {
                    stats[i._id] = {status: i.status, novice: i.novice, openTime: i.openTime};
                });
                return db['rooms.objects'].find({$and: [{room: {$in: req.body.rooms}}, {type: 'controller'}]});
            })
            .then((data) => {
                data.forEach((i) => {
                    if (i.user) {
                        stats[i.room].own = _.pick(i, ['user', 'level']);
                        users[i.user] = true;
                    }
                    if (i.reservation) {
                        stats[i.room].own = {user: i.reservation.user, level: 0};
                        users[i.reservation.user] = true;
                    }
                    if (i.sign) {
                        stats[i.room].sign = i.sign;
                        users[i.sign.user] = true;
                    }
                    if (i.safeMode > gameTime) {
                        stats[i.room].safeMode = true;
                    }
                });

                statsMax = {};

                switch (statName) {
                    case "none":
                    case "owner": {
                        return q.when();
                    }

                    case "minerals": {
                        return db['rooms.objects'].find({$and: [{type: 'mineral'}, {room: {$in: req.body.rooms}}]})
                        .then(data => {
                            data.forEach(i => {
                                stats[i.room].minerals0 = {type: i.mineralType, density: i.density};
                            })
                        })
                    }

                    default: {
                        if (!_.includes(statsMod.statNames, statName)) {
                            return q.when();
                        }
                        
                        // get summed max for this interval
                        var blockStart = endTime - blocks + 1;
                        return db["rooms.stats.max"].find({ $and: [{ endTime: { $gte: blockStart } }, { interval }] })
                        .then((results) => {
                            statsMax[statKey] = _.reduce(results, (sum, obj) => sum + (obj[statName] || 0), 0);
                        })
                        .then(() => db['rooms.stats' + interval].find({ $and: [{ endTime: { $gte: blockStart } }, { room: { $in: req.body.rooms } }]}))
                        .then((rawStats) => {
                            console.log("map-stats", statName);
                            var roomUserSums = {};
                            for (var statObj of rawStats) {
                                if (!statObj[statName]) continue;
                                console.log(statObj.room, statObj.endTime, statObj[statName]);
                                roomUserSums[statObj.room] = roomUserSums[statObj.room] || {};
                                roomUserSums[statObj.room][statObj.user] = (roomUserSums[statObj.room][statObj.user] || 0) + statObj[statName];
                            }

                            for (var room in roomUserSums) {
                                stats[room][statKey] = _.map(roomUserSums[room], (value, user) => ({ user, value }));
                            }
                        });
                    }
                }
            })
            .then(() => db.users.find({_id: {$in: _.keys(users)}}))
            .then(unknownUsers => {
                let users = _.reduce(unknownUsers, (result, user) => {
                    result[user._id.toString()] = _.pick(user, [ "_id", "username", "badge" ]);
                    return result;
                }, {});

                res.send({
                    ok: 1,
                    gameTime,
                    stats,
                    statsMax,
                    users,
                    debug
                });
            });
        });

        return router;
    }
}