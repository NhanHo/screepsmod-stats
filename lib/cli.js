const q = require('q')

module.exports = function (config, statsMod) {
    config.cli.on("cliSandbox", function (sandbox) {
        sandbox.updateLeaderboardSeason = statsMod.updateLeaderboardSeason;
        sandbox.resetSeason = () => {
            var storage = config.common.storage;
            storage.env.get(storage.env.keys.LEADERBOARD_SEASON).then((season) => {
                var boardDefs = config['screepsmod-stats'].leaderboards;
                var promises = [];
                for (let mode in boardDefs) {
                    promises.push(storage.db[`leaderboard.${mode}`].clear());
                }

                return q.all(promises);
            })
        };

        sandbox.clearStats = () => {
            var db = config.common.storage.db;
            return q.all([
                db['rooms.stats'].clear(),
                db['rooms.stats8'].clear(),
                db['rooms.stats180'].clear(),
                db['rooms.stats1440'].clear(),
                db['rooms.stats.max'].clear()
            ]);
        };
    });
};