import { memo, useCallback, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronRight, Code2, ShieldCheck } from 'lucide-react';
import { DeveloperInfoView } from './DeveloperInfoView.tsx';

export const ProfileView = memo(function ProfileView() {
  const [showDeveloperInfo, setShowDeveloperInfo] = useState(false);

  const handleOpenDevInfo = useCallback(() => setShowDeveloperInfo(true), []);
  const handleCloseDevInfo = useCallback(() => setShowDeveloperInfo(false), []);

  return (
    <section className="flex-1 w-full px-4 sm:px-8 pt-6 pb-10 bg-gradient-to-b from-[#FFFFFF] via-[#FDFBF7] to-[#F5EEDB] text-[#09090B]">
      <AnimatePresence mode="wait" initial={false}>
        {showDeveloperInfo ? (
          <DeveloperInfoView key="dev-info" onBack={handleCloseDevInfo} />
        ) : (
          <motion.div
            key="profile-main"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
            style={{ willChange: 'transform, opacity' }}
            className="w-full max-w-2xl mx-auto space-y-5 transform-gpu"
          >
            {/* Header */}
            <div className="px-1">
              <p className="text-[11px] font-semibold tracking-[0.2em] uppercase text-[#9A7209]">
                Terminal Profile &amp; Info
              </p>
              <h1 className="font-display font-bold text-2xl sm:text-3xl tracking-tight text-[#09090B] mt-0.5">
                Profile
              </h1>
            </div>

            {/* User Identity & Status Card */}
            <div className="rounded-3xl bg-white border border-[#D4AF37]/40 shadow-[0_12px_32px_-16px_rgba(140,100,5,0.18)] p-6 sm:p-8 space-y-6">
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#FBF5E3] to-[#F3E5BE] border border-[#D4AF37]/50 shadow-sm flex items-center justify-center overflow-hidden shrink-0">
                  <img
                    src="/assets/aistudio/images_0b890af9.png"
                    alt="LEADERS XAUUSD"
                    decoding="async"
                    className="w-full h-full object-cover"
                  />
                </div>

                <div className="min-w-0 flex-1">
                  <h2 className="font-display font-bold text-lg sm:text-xl text-[#09090B] truncate">
                    LEADERS XAUUSD
                  </h2>
                  <div className="mt-1 inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                    <span>Direct Terminal Access</span>
                  </div>
                </div>
              </div>

              <div className="h-[1px] w-full bg-gradient-to-r from-[#D4AF37]/35 via-[#D4AF37]/20 to-transparent" />

              {/* Profile Details Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="rounded-2xl bg-[#FCF9F0] border border-[#D4AF37]/25 px-4 py-3.5">
                  <div className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.14em] uppercase text-[#71717A]">
                    <img
                      src="/assets/aistudio/images_0b890af9.png"
                      alt="LEADERS XAUUSD Icon"
                      className="w-4 h-4 rounded-full object-cover shrink-0"
                    />
                    <span>User Profile</span>
                  </div>
                  <p className="mt-1.5 font-display text-sm sm:text-base font-bold text-[#09090B]">
                    leaders Xauusd user
                  </p>
                </div>

                <div className="rounded-2xl bg-[#FCF9F0] border border-[#D4AF37]/25 px-4 py-3.5">
                  <div className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.14em] uppercase text-[#71717A]">
                    <ShieldCheck className="w-3.5 h-3.5 text-[#9A7209]" />
                    <span>Terminal Status</span>
                  </div>
                  <p className="mt-1.5 font-display text-sm font-semibold text-[#09090B]">
                    Active · Instant Open
                  </p>
                </div>
              </div>
            </div>

            {/* Menu Card: Developer Info */}
            <div className="rounded-3xl bg-white border border-[#D4AF37]/40 shadow-[0_12px_30px_-16px_rgba(140,100,5,0.16)] overflow-hidden">
              <button
                type="button"
                onClick={handleOpenDevInfo}
                className="w-full min-h-[68px] px-6 py-4 flex items-center justify-between gap-4 hover:bg-[#FCF8EC] active:bg-[#F7EED6] transition-colors text-left cursor-pointer"
              >
                <div className="flex items-center gap-4 min-w-0">
                  <span className="w-11 h-11 rounded-2xl bg-gradient-to-br from-[#FBF5E3] to-[#F3E5BE] border border-[#D4AF37]/45 flex items-center justify-center shrink-0">
                    <Code2 className="w-5 h-5 text-[#8E6603]" />
                  </span>
                  <div className="min-w-0">
                    <div className="font-display font-bold text-base text-[#09090B]">
                      Developer Info
                    </div>
                    <div className="text-xs text-[#52525B] truncate">
                      Engineering team &amp; direct contact numbers
                    </div>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-[#9A7209] shrink-0" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
});
