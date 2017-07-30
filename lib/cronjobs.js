module.exports = function (config, statsMod) {
    config.cronjobs.updateLeaderboardSeason = [ 300, statsMod.updateLeaderboardSeason ];
    config.cronjobs.updateRoomStats = [ 60, statsMod.updateRoomStats ];
}