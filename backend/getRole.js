function getRole(user) {
    if (!user) return 'user';
    if (user.is_admin) return 'admin';
    if (user.is_banned) return 'banned';
    if (user.company_verified) return 'company';
    const isSubActive = user.premium_expires_at && new Date(user.premium_expires_at) > new Date();
    if (isSubActive && user.subscription_tier === 'gold') return 'gold';
    if (isSubActive && user.subscription_tier === 'silver') return 'silver';
    if (user.reputation_score >= 500) return 'moderator';
    return 'user';
}

module.exports = getRole;
