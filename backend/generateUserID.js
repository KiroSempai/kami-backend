function generateUserId() {

    const prefixes = [
        "Shadow","Moon","Crimson","Night","Solar","Ghost","Iron",
        "Void","Silver","Dark","Storm","Cyber","Frost","Blood",
        "Inferno","Nova","Phantom","Omega","Obsidian","Astral",
        "Venom","Blaze","Titan","Lucid","Chaos","Eclipse","Zenith",
        "Drift","Mystic","Neon","Rogue","Spectral","Thunder","Vortex",
        "Ember","Abyss","Quantum","Turbo","Skull","Fatal"
    ]

    const middles = [
        "Fox","Wolf","Blade","Dragon","Hunter","Crow","Phantom",
        "Nova","Reaper","Viper","Raven","Tiger","Snake","Demon",
        "Samurai","Knight","Falcon","Warden","Beast","Ghost",
        "Crusher","Walker","Slayer","Pulse","Fang","Core","Striker",
        "Titan","Breaker","Storm","Sniper","Mage","Pirate","Oracle",
        "Specter","Rider","Shade","Monarch","Berserk","Sentinel"
    ]

    const suffixes = [
        "X","Zero","Prime","EX","Ultra","VX","Core","Edge","Max",
        "Alpha","Beta","Z","XR","Neo","Void","Sync","Flux","Wave",
        "Byte","Dash","Spark","Strike","Code","Drive","Rise","Zone",
        "Burst","Shift","Rune","Nova"
    ]

    const randomPrefix =
        prefixes[Math.floor(Math.random() * prefixes.length)]

    const randomMiddle =
        middles[Math.floor(Math.random() * middles.length)]

    const randomSuffix =
        suffixes[Math.floor(Math.random() * suffixes.length)]

    const randomNumbers =
        Math.floor(1000 + Math.random() * 9000)

    return `${randomPrefix}${randomMiddle}${randomSuffix}${randomNumbers}`
}