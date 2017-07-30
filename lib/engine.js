const package = require("../package.json");
const _ = require('lodash');
const q = require('q');

module.exports = function (config, statsMod) {
    config.engine.on('init', function (processType) {
        if (config.features) {
            config.features.defineFeature("leaderboard", package.name, package.version);
            config.features.defineFeature("room-stats", package.name, package.version);
        }
    });

    var storage = config.common.storage;
    var driver = config.engine.driver;

    var roomStatsUpdates = {};

    driver.getRoomStatsUpdater = (room) => {
        return {
            inc(name, userId, amount) {
                roomStatsUpdates[room] = roomStatsUpdates[room] || {};
                roomStatsUpdates[room][userId] = roomStatsUpdates[room][userId] || {};
                roomStatsUpdates[room][userId][name] = roomStatsUpdates[room][userId][name] || 0;
                roomStatsUpdates[room][userId][name] += amount;
            }
        }
    };

    driver.roomsStatsSave = () => {
        var roomsStatsInsertOps = [];
        var endTime = Date.now();
        for (let roomName in roomStatsUpdates) {
            let roomStats = roomStatsUpdates[roomName];
            for (let userId in roomStats) {
                let statsObj = roomStats[userId];
                statsObj.user = userId;
                statsObj.room = roomName;
                statsObj.endTime = endTime;
                
                roomsStatsInsertOps.push(statsObj);
            }
        }

        // Really I'd want to push this as an inc operation directly to the various interval collections, but I can't
        // figure out how to do it as a bulk operation. Therefore I'll push these into a temporary table and do the
        // post-processing in a cronjob.
        roomStatsUpdates = {};
        if (roomsStatsInsertOps.length > 0) {
            console.log(`Inserting ${roomsStatsInsertOps.length} stat blocks`);
            return storage.db["rooms.stats"].insert(roomsStatsInsertOps);
        }
    };
};