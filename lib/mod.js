const _ = require('lodash');
const q = require('q');


module.exports = function (config) {
    // fail without common
    var storage = config.common.storage;
    var env = storage.env;
    
    function ensureCollection(collectionName) {
        if (!_.includes(config.common.dbCollections, collectionName)) {
            config.common.dbCollections.push(collectionName);
            console.log("statsmod added collection", collectionName);
        }
    }

    const statIntervals = { 8: 8, 180: 8, 1440: 7 };
    const leaderboards = {
        "world": { statName: "energyControl" },
        "power": { statName: "powerProcessed" }
    };
    const statNames = ["energyHarvested","energyConstruction","energyCreeps","energyControl","creepsProduced","creepsLost","powerProcessed"];

    ensureCollection("rooms.stats");
    ensureCollection("rooms.stats.max");
    for (let interval in statIntervals) {
        ensureCollection(`rooms.stats${interval}`);
    }
    for (let mode in leaderboards) {
        ensureCollection("leaderboard." + mode);
    }

    env.keys.LEADERBOARD_SEASON = "leaderboardSeason";

    function updateLeaderboards(rawStats) {
        return env.get(env.keys.LEADERBOARD_SEASON).then((currentSeason) => {
            if (!currentSeason) return;
            
            var boardDelta = {};
            for (let mode in leaderboards) {
                boardDelta[mode] = {};
            }

            // merge each user's roomStats objects based on each leaderboard's statName
            for (let statsObj of rawStats) {
                for (let mode in leaderboards) {
                    let statName = leaderboards[mode].statName;
                    if (statsObj[statName]) {
                        boardDelta[mode][statsObj.user] = (boardDelta[mode][statsObj.user] || 0) + statsObj[statName];
                    }
                }
            }

            // query each leaderboard for the current season & increment/insert all user entries
            var promises = [];
            for (let mode in boardDelta) {
                let collection = storage.db[`leaderboard.${mode}`];
                let delta = boardDelta[mode];
                promises.push(collection.find({ season: currentSeason }).then((previousData) => {
                    let mapped = _.reduce(previousData, (result, obj) => {
                        result[obj.user] = _.pick(obj, ['_id', 'season', 'score', 'user']);
                        return result;
                    }, {});

                    for (var user in delta) {
                        mapped[user] = mapped[user] || { user, score: 0 };
                        mapped[user].score += delta[user];
                    }

                    let bulkOps = [];
                    let sorted = _.sortByOrder(mapped, ['score'], ['desc']);
                    for (let i = 0; i < sorted.length; i++) {
                        if (sorted[i]._id) {
                            bulkOps.push({
                                op: 'update',
                                id: sorted[i]._id,
                                $set: { score: sorted[i].score, rank: i }
                            });
                        } else {
                            bulkOps.push({
                                op: 'insert',
                                data: { season: currentSeason, user: sorted[i].user, score: sorted[i].score, rank: i }
                            });
                        }
                    }

                    return collection.bulk(bulkOps);
                }));
            }

            return q.all(promises);
        });
    }

    function updateUserStats(rawStats) {
        var now = Date.now();
        var promises = [];

        // for each interval insert new statblocks for the current endTime bucket, or create a new blocks
        var dbLookupPromises = []
        for (let interval in statIntervals) {
            let endTime = Math.floor(now / (interval * 1000 * 60));
            let collection = storage.db[`rooms.stats${interval}`];
            dbLookupPromises.push(collection.find({ endTime }).then((results) => {
                var bucketMax = {};
                for (var statName of statNames) {
                    bucketMax[statName] = 0;
                }

                // remap all the blocks in the current bucket so lookup will be easier
                var data = {};
                for (var dbObj of results) {
                    data[dbObj.user] = data[dbObj.user] || {};
                    data[dbObj.user][dbObj.room] = dbObj;

                    for (var statName of statNames) {
                        if (dbObj[statName] && (dbObj[statName] > bucketMax[statName])) {
                            bucketMax[statName] = dbObj[statName];
                        }
                    }
                }

                // increment the stat counters
                for (let statsObj of rawStats) {
                    if (data[statsObj.user] && data[statsObj.user][statsObj.room]) {
                        var existingDoc = data[statsObj.user][statsObj.room];
                        for (var statName of statNames) {
                            if (statsObj[statName]) {
                                existingDoc[statName] = (existingDoc[statName] || 0) + statsObj[statName];
                                if (existingDoc[statName] > bucketMax[statName]) {
                                    bucketMax[statName] = existingDoc[statName];
                                }
                            }
                        }

                        if (!existingDoc.op) existingDoc.op = 'update';
                    } else {
                        var insertData = { user: statsObj.user, room: statsObj.room, endTime, op: 'insert' };
                        for (var statName of statNames) {
                            if (statsObj[statName]) {
                                insertData[statName] = statsObj[statName];
                                if (statsObj[statName] > bucketMax[statName]) {
                                    bucketMax[statName] = statsObj[statName];
                                }
                            }
                        }

                        data[statsObj.user] = data[statsObj.user] || {};
                        data[statsObj.user][statsObj.room] = insertData;
                    }
                }

                // convert the changes into bulk op form
                var bulkOps = [];
                for (let user in data) {
                    for (let room in data[user]) {
                        let doc = data[user][room];
                        if (doc.op === "insert") {
                            delete doc.op;
                            bulkOps.push({
                                op: 'insert',
                                data: doc
                            });
                        } else if (doc.op === "update") {
                            delete doc.op;
                            bulkOps.push({
                                op: 'update',
                                id: doc._id,
                                $set: doc
                            });
                        }
                    }
                }

                return collection.bulk(bulkOps).then(() => {
                    // This means the stat max blocks can be from different rooms for each bucket. This is much easier
                    // to compute, but it means the result of "max energy harvested in the past hour" is not intuitive.
                    var obj = { endTime, interval };
                    for (let statName of statNames) {
                        if (bucketMax[statName]) obj[statName] = bucketMax[statName];
                    }
                    return storage.db['rooms.stats.max'].update({$and: [{ endTime }, { interval }]}, { $set: obj }, { upsert: true });
                });
            }));
        }

        return q.all(dbLookupPromises);
    }

    return {
        name: "screepsmod-stats",

        leaderboards,
        statNames,
        statIntervals,

        updateLeaderboardSeason() {
            var date = new Date();
            var year = date.getFullYear();
            var id = `${year}-${date.toLocaleString("en-us", { month: "2-digit" })}`;
            return storage.db["leaderboard.seasons"].findOne(id).then(result => {
                if (result) {
                    return env.set(env.keys.LEADERBOARD_SEASON, id);
                }

                return storage.db["leaderboard.seasons"].insert({
                    _id: id,
                    name: `${date.toLocaleString("en-us", { month: "long" })} ${year}`,
                    date: date.toISOString()
                }).then(() => {
                    console.log("Started new season:", id);
                    return env.set(env.keys.LEADERBOARD_SEASON, id);
                });
            });
        },

        updateRoomStats() {
            var queryTime = Date.now();
            return storage.db['rooms.stats'].find().then((rawStats) => {
                return q.all([
                    updateLeaderboards(rawStats),
                    updateUserStats(rawStats)
                ]).then(() => {
                    storage.db['rooms.stats'].removeWhere({ endTime: { $lte: queryTime } })
                });
            });
        }
    }
}