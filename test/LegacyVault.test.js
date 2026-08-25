const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

const BPS = 10_000n;
const DAY = 24n * 60n * 60n;

async function deployFixture() {
  const [owner, guardian, ben1, ben2, ben3, stranger] = await ethers.getSigners();

  const Vault = await ethers.getContractFactory("LegacyVault");
  const vault = await Vault.deploy();

  const deposit = ethers.parseEther("100");
  const interval = DAY;
  const disputeWindow = DAY / 2n;
  await vault
    .connect(owner)
    .createVault([ben1.address, ben2.address], [6000, 4000], guardian.address, interval, disputeWindow, 25, {
      value: deposit,
    });

  return { vault, vaultId: 1n, owner, guardian, ben1, ben2, ben3, stranger, deposit, interval, disputeWindow };
}

async function triggeredFixture() {
  const base = await loadFixture(deployFixture);
  await time.increase(base.interval + 5n);
  return base;
}

describe("LegacyVault", function () {
  describe("createVault", function () {
    it("stores the full vault configuration", async function () {
      const { vault, owner, guardian, deposit, interval, disputeWindow } = await loadFixture(deployFixture);

      const v = await vault.getVault(1);
      expect(v.owner).to.equal(owner.address);
      expect(v.guardian).to.equal(guardian.address);
      expect(v.balance).to.equal(deposit);
      expect(v.checkInInterval).to.equal(interval);
      expect(v.disputeWindow).to.equal(disputeWindow);
      expect(v.tranche1Percent).to.equal(25n);
      expect(v.status).to.equal(0n); // Active

      const [, shares, t1Flags, fFlags] = await vault.getBeneficiaries(1);
      expect(shares.map((s) => BigInt(s))).to.deep.equal([6000n, 4000n]);
      expect(t1Flags).to.deep.equal([false, false]);
      expect(fFlags).to.deep.equal([false, false]);
    });

    it("indexes the vault for the owner and each beneficiary", async function () {
      const { vault, owner, ben1 } = await loadFixture(deployFixture);
      expect((await vault.getUserVaultIds(owner.address)).map(BigInt)).to.deep.equal([1n]);
      expect((await vault.getVaultsByBeneficiary(ben1.address)).length).to.equal(1);
    });

    it("rejects shares that do not sum to 10000 bps", async function () {
      const { vault, owner, ben1, ben2 } = await loadFixture(deployFixture);
      await expect(
        vault.connect(owner).createVault([ben1.address, ben2.address], [5000, 4000], owner.address, DAY, DAY, 25, {
          value: 1,
        })
      ).to.be.revertedWith("LV: shares must sum to 10000 bps");
    });

    it("rejects duplicate beneficiaries", async function () {
      const { vault, owner, ben1 } = await loadFixture(deployFixture);
      await expect(
        vault.connect(owner).createVault([ben1.address, ben1.address], [5000, 5000], owner.address, DAY, DAY, 25, {
          value: 1,
        })
      ).to.be.revertedWith("LV: duplicate beneficiary");
    });

    it("rejects zero deposit", async function () {
      const { vault, owner, ben1 } = await loadFixture(deployFixture);
      await expect(
        vault.connect(owner).createVault([ben1.address], [BPS], owner.address, DAY, DAY, 25, { value: 0 })
      ).to.be.revertedWith("LV: no deposit");
    });

    it("rejects check-in intervals below the 60s floor", async function () {
      const { vault, owner, ben1 } = await loadFixture(deployFixture);
      await expect(
        vault.connect(owner).createVault([ben1.address], [BPS], owner.address, 59n, DAY, 25, { value: 1 })
      ).to.be.revertedWith("LV: interval < 60s");
    });

    it("rejects tranche1 percent outside 1..99", async function () {
      const { vault, owner, ben1 } = await loadFixture(deployFixture);
      for (const pct of [0n, 100n]) {
        await expect(
          vault.connect(owner).createVault([ben1.address], [BPS], owner.address, DAY, DAY, pct, { value: 1 })
        ).to.be.revertedWith("LV: tranche1 % out of range");
      }
    });

    it("reverts direct sends without calldata", async function () {
      const { vault, stranger } = await loadFixture(deployFixture);
      await expect(stranger.sendTransaction({ to: await vault.getAddress(), value: 1 })).to.be.reverted;
    });
  });

  describe("checkIn / deposit", function () {
    it("extends the deadline on check-in (normal cycle)", async function () {
      const { vault, vaultId, owner, interval } = await loadFixture(deployFixture);

      await time.increase(interval / 2n);
      let remaining = await vault.timeUntilTimeout(vaultId);
      expect(remaining).to.be.closeTo(interval / 2n, 5n);

      await vault.connect(owner).checkIn(vaultId);
      remaining = await vault.timeUntilTimeout(vaultId);
      expect(remaining).to.be.closeTo(interval, 5n);
    });

    it("reverts when a non-owner checks in", async function () {
      const { vault, vaultId, stranger } = await loadFixture(deployFixture);
      await expect(vault.connect(stranger).checkIn(vaultId)).to.be.revertedWith("LV: not vault owner");
    });

    it("allows the owner to top up while Active", async function () {
      const { vault, vaultId, owner, deposit } = await loadFixture(deployFixture);
      const extra = ethers.parseEther("7");
      await expect(vault.connect(owner).deposit(vaultId, { value: extra }))
        .to.emit(vault, "Deposited")
        .withArgs(vaultId, owner.address, extra);

      const v = await vault.getVault(vaultId);
      expect(v.balance).to.equal(deposit + extra);
    });

    it("blocks deposits once triggered", async function () {
      const base = await triggeredFixture();
      await base.vault.connect(base.stranger).triggerRelease(base.vaultId);
      await expect(
        base.vault.connect(base.owner).deposit(base.vaultId, { value: 1 })
      ).to.be.revertedWith("LV: not active");
    });
  });

  describe("trigger + cancel", function () {
    it("anyone can trigger after timeout", async function () {
      const { vault, vaultId, stranger } = await triggeredFixture();

      await vault.connect(stranger).triggerRelease(vaultId);
      const v = await vault.getVault(vaultId);
      expect(v.status).to.equal(1n); // TriggerPending
      expect(v.triggeredAt).to.not.equal(0n);
    });

    it("cannot trigger before timeout", async function () {
      const { vault, vaultId, stranger } = await loadFixture(deployFixture);
      await expect(vault.connect(stranger).triggerRelease(vaultId)).to.be.revertedWith("LV: not timed out");
    });

    it("guardian cancels inside the dispute window", async function () {
      const base = await triggeredFixture();
      await base.vault.connect(base.stranger).triggerRelease(base.vaultId);

      await expect(base.vault.connect(base.guardian).cancelRelease(base.vaultId))
        .to.emit(base.vault, "ReleaseCancelled")
        .withArgs(base.vaultId, base.guardian.address);

      const v = await base.vault.getVault(base.vaultId);
      expect(v.status).to.equal(0n); // back to Active
      expect(v.triggeredAt).to.equal(0n);
      expect(await base.vault.timeUntilTimeout(base.vaultId)).to.be.closeTo(base.interval, 5n);
    });

    it("returning owner cancels inside the dispute window", async function () {
      const base = await triggeredFixture();
      await base.vault.connect(base.stranger).triggerRelease(base.vaultId);

      await base.vault.connect(base.owner).cancelRelease(base.vaultId);
      const v = await base.vault.getVault(base.vaultId);
      expect(v.status).to.equal(0n);
    });

    it("cannot cancel after the dispute window has closed", async function () {
      const base = await triggeredFixture();
      await base.vault.connect(base.stranger).triggerRelease(base.vaultId);
      await time.increase(base.disputeWindow + 5n);

      await expect(base.vault.connect(base.owner).cancelRelease(base.vaultId)).to.be.revertedWith(
        "LV: dispute window closed"
      );
      await expect(base.vault.connect(base.guardian).cancelRelease(base.vaultId)).to.be.revertedWith(
        "LV: dispute window closed"
      );
    });

    it("strangers cannot cancel", async function () {
      const base = await triggeredFixture();
      await base.vault.connect(base.stranger).triggerRelease(base.vaultId);
      await expect(base.vault.connect(base.stranger).cancelRelease(base.vaultId)).to.be.revertedWith(
        "LV: not owner/guardian"
      );
    });
  });

  describe("full release flow", function () {
    async function pendingExpiredFixture() {
      const base = await triggeredFixture();
      await base.vault.connect(base.stranger).triggerRelease(base.vaultId);
      await time.increase(base.disputeWindow + 5n);
      return base;
    }

    it("pays tranche-1 slices pro-rata via pull payment", async function () {
      const base = await pendingExpiredFixture();
      const { vault, vaultId, ben1, ben2, deposit } = base;

      const t1Pool = (deposit * 25n) / 100n; // 25 ETH
      const exp1 = (t1Pool * 6000n) / BPS; // 15 ETH
      const exp2 = (t1Pool * 4000n) / BPS; // 10 ETH

      await expect(vault.connect(ben1).claimTranche1(vaultId))
        .to.emit(vault, "Tranche1Claimed")
        .withArgs(vaultId, ben1.address, exp1);
      await vault.connect(ben2).claimTranche1(vaultId);

      expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(deposit - exp1 - exp2);

      const v = await vault.getVault(vaultId);
      expect(v.status).to.equal(2n); // TrancheOneReleased
      expect(v.balance).to.equal(deposit - t1Pool);
    });

    it("reverts tranche-1 claim by a non-beneficiary", async function () {
      const base = await pendingExpiredFixture();
      await expect(base.vault.connect(base.stranger).claimTranche1(base.vaultId)).to.be.revertedWith(
        "LV: not a beneficiary"
      );
    });

    it("blocks tranche-1 while the dispute window is open", async function () {
      const base = await triggeredFixture();
      await base.vault.connect(base.stranger).triggerRelease(base.vaultId);
      await time.increase(base.disputeWindow - 10n);
      await expect(base.vault.connect(base.ben1).claimTranche1(base.vaultId)).to.be.revertedWith(
        "LV: dispute window open"
      );
    });

    it("prevents double claiming of tranche-1", async function () {
      const base = await pendingExpiredFixture();
      await base.vault.connect(base.ben1).claimTranche1(base.vaultId);
      await expect(base.vault.connect(base.ben1).claimTranche1(base.vaultId)).to.be.revertedWith(
        "LV: already claimed t1"
      );
    });

    it("final claim pays the remainder after a second full interval", async function () {
      const base = await pendingExpiredFixture();
      const { vault, vaultId, ben1, ben2, owner, deposit, interval } = base;

      const t1Pool = (deposit * 25n) / 100n;
      await vault.connect(ben1).claimTranche1(vaultId);
      await vault.connect(ben2).claimTranche1(vaultId);

      // Final delay not yet elapsed.
      await time.increase(interval - 20n);
      await expect(vault.connect(ben1).claimFinal(vaultId)).to.be.revertedWith("LV: final delay not elapsed");

      await time.increase(30n);
      const rest = deposit - t1Pool; // 75 ETH
      const expF1 = (rest * 6000n) / BPS;
      const expF2 = rest - expF1;

      await expect(vault.connect(ben1).claimFinal(vaultId))
        .to.emit(vault, "FinalClaimed")
        .withArgs(vaultId, ben1.address, expF1);
      await vault.connect(ben2).claimFinal(vaultId);

      const v = await vault.getVault(vaultId);
      expect(v.status).to.equal(3n); // FullyReleased
      expect(v.balance).to.equal(0n);
      expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(0n);
      void owner;
    });

    it("reverts final claim by a non-beneficiary", async function () {
      const base = await pendingExpiredFixture();
      await base.vault.connect(base.ben1).claimTranche1(base.vaultId);
      await time.increase(base.interval + 5n);
      await expect(base.vault.connect(base.stranger).claimFinal(base.vaultId)).to.be.revertedWith(
        "LV: not a beneficiary"
      );
    });
  });

  describe("revival rule (R1)", function () {
    it("owner check-in during TrancheOneReleased revives the vault; late t1 claims forfeited", async function () {
      const base = await triggeredFixture();
      const { vault, vaultId, owner, ben1, ben2, deposit, interval } = base;

      await vault.connect(base.stranger).triggerRelease(vaultId);
      await time.increase(base.disputeWindow + 5n);

      // ben1 grabs their slice before the owner reappears.
      const t1Pool = (deposit * 25n) / 100n;
      const exp1 = (t1Pool * 6000n) / BPS;
      await vault.connect(ben1).claimTranche1(vaultId);

      // Owner returns within one interval -> vault is Active again.
      await vault.connect(owner).checkIn(vaultId);
      let v = await vault.getVault(vaultId);
      expect(v.status).to.equal(0n); // Active

      // ben2 missed the boat: their tranche-1 slice is forfeited.
      await expect(vault.connect(ben2).claimTranche1(vaultId)).to.be.revertedWith("LV: wrong status");

      // And the clock restarts from this check-in.
      expect(await vault.timeUntilTimeout(vaultId)).to.be.closeTo(interval, 5n);
      void exp1;
    });

    it("owner cannot checkIn during TriggerPending (must use cancelRelease)", async function () {
      const base = await triggeredFixture();
      await base.vault.connect(base.stranger).triggerRelease(base.vaultId);
      await expect(base.vault.connect(base.owner).checkIn(base.vaultId)).to.be.revertedWith(
        "LV: checkIn not allowed in this state"
      );
    });
  });

  describe("beneficiary management", function () {
    it("updateShares replaces the list and validates sums", async function () {
      const base = await loadFixture(deployFixture);
      const { vault, vaultId, owner, ben1, ben2, ben3 } = base;

      await vault.connect(owner).updateShares(vaultId, [ben1.address, ben2.address, ben3.address], [5000, 3000, 2000]);
      const [wallets, shares] = await vault.getBeneficiaries(vaultId);
      expect(wallets).to.include(ben3.address);
      expect(shares.map((s) => BigInt(s))).to.deep.equal([5000n, 3000n, 2000n]);

      await expect(
        vault.connect(owner).updateShares(vaultId, [ben1.address, ben2.address], [6000, 5000])
      ).to.be.revertedWith("LV: shares must not exceed 10000 bps");

      await expect(
        vault.connect(owner).updateShares(vaultId, [ben1.address, ben2.address], [5000, 5000])
      ).to.not.be.reverted;
    });

    it("add/remove maintain the share invariant", async function () {
      const { vault, vaultId, owner, ben1, ben2, ben3 } = await loadFixture(deployFixture);

      // Free up room first, then add.
      await vault.connect(owner).updateShares(vaultId, [ben1.address, ben2.address], [5000, 4500]);
      await vault.connect(owner).addBeneficiary(vaultId, ben3.address, 500);
      const [, sharesAfterAdd] = await vault.getBeneficiaries(vaultId);
      const sumAdd = sharesAfterAdd.reduce((a, s) => a + BigInt(s), 0n);
      expect(sumAdd).to.equal(BPS);

      // Remove ben2: ben1+ben3 rescale to fill 100%.
      await vault.connect(owner).removeBeneficiary(vaultId, ben2.address);
      const [walletsAfterRemove, sharesAfterRemove] = await vault.getBeneficiaries(vaultId);
      expect(walletsAfterRemove.map((w) => w.toLowerCase())).to.not.include(ben2.address.toLowerCase());
      const sumRemove = sharesAfterRemove.reduce((a, s) => a + BigInt(s), 0n);
      expect(sumRemove).to.equal(BPS);
      expect(await vault.isBeneficiary(vaultId, ben2.address)).to.equal(false);

      await expect(vault.connect(owner).removeBeneficiary(vaultId, ben2.address)).to.be.revertedWith(
        "LV: not a beneficiary"
      );
    });

    it("management is locked once triggered", async function () {
      const base = await triggeredFixture();
      await base.vault.connect(base.stranger).triggerRelease(base.vaultId);
      await expect(
        base.vault.connect(base.owner).changeGuardian(base.vaultId, base.stranger.address)
      ).to.be.revertedWith("LV: not active");
    });

    it("owner can rotate the guardian", async function () {
      const { vault, vaultId, owner, guardian, stranger } = await loadFixture(deployFixture);
      await expect(vault.connect(owner).changeGuardian(vaultId, stranger.address))
        .to.emit(vault, "GuardianChanged")
        .withArgs(vaultId, guardian.address, stranger.address);
      const v = await vault.getVault(vaultId);
      expect(v.guardian).to.equal(stranger.address);
    });
  });
});
