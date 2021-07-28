pragma solidity ^0.6.10;
pragma experimental ABIEncoderV2;

// Inheritance
import "./BaseRewardEscrowV2.sol";

// Internal references
import "./interfaces/IRewardEscrow.sol";
import "./interfaces/ISystemStatus.sol";

contract RewardEscrowV2 is BaseRewardEscrowV2 {
    mapping(address => uint256) public totalBalancePendingMigration;

    uint public migrateEntriesThresholdAmount = SafeDecimalMath.unit() * 1000; // Default 1000 DPS

    /* ========== ADDRESS RESOLVER CONFIGURATION ========== */

    bytes32 private constant CONTRACT_REWARD_ESCROW = "RewardEscrow";
    bytes32 private constant CONTRACT_SYSTEMSTATUS = "SystemStatus";

    /* ========== CONSTRUCTOR ========== */

    constructor(address _owner, address _resolver) public BaseRewardEscrowV2(_owner, _resolver) {}

    /* ========== VIEWS ======================= */

    function resolverAddressesRequired() public view override returns (bytes32[] memory addresses) {
        bytes32[] memory existingAddresses = BaseRewardEscrowV2.resolverAddressesRequired();
        bytes32[] memory newAddresses = new bytes32[](3);
        newAddresses[1] = CONTRACT_REWARD_ESCROW;
        newAddresses[2] = CONTRACT_SYSTEMSTATUS;
        return combineArrays(existingAddresses, newAddresses);
    }

    function oldRewardEscrow() internal view returns (IRewardEscrow) {
        return IRewardEscrow(requireAndGetAddress(CONTRACT_REWARD_ESCROW));
    }

    function systemStatus() internal view returns (ISystemStatus) {
        return ISystemStatus(requireAndGetAddress(CONTRACT_SYSTEMSTATUS));
    }

    /* ========== OLD ESCROW LOOKUP ========== */

    uint internal constant TIME_INDEX = 0;
    uint internal constant QUANTITY_INDEX = 1;

    /* ========== MIGRATION OLD ESCROW ========== */

    /* Threshold amount for migrating escrow entries from old RewardEscrow */
    function setMigrateEntriesThresholdAmount(uint amount) external onlyOwner {
        migrateEntriesThresholdAmount = amount;
        emit MigrateEntriesThresholdAmountUpdated(amount);
    }

    /* Function to allow any address to migrate vesting entries from previous reward escrow */
    function migrateVestingSchedule(address addressToMigrate) external override systemActive {
        /* Ensure account escrow balance pending migration is not zero */
        /* Ensure account escrowed balance is not zero - should have been migrated */
        require(totalBalancePendingMigration[addressToMigrate] > 0, "No escrow migration pending");
        require(totalEscrowedAccountBalance[addressToMigrate] > 0, "Address escrow balance is 0");

        /* Add a vestable entry for addresses with totalBalancePendingMigration <= migrateEntriesThreshold amount of DPS */
        if (totalBalancePendingMigration[addressToMigrate] <= migrateEntriesThresholdAmount) {
            _importVestingEntry(
                addressToMigrate,
                VestingEntries.VestingEntry({
                    endTime: uint64(block.timestamp),
                    escrowAmount: totalBalancePendingMigration[addressToMigrate]
                })
            );

            /* Remove totalBalancePendingMigration[addressToMigrate] */
            delete totalBalancePendingMigration[addressToMigrate];
        } else {
            uint numEntries = oldRewardEscrow().numVestingEntries(addressToMigrate);

            /* iterate and migrate old escrow schedules from rewardEscrow.vestingSchedules
             * starting from the last entry in each staker's vestingSchedules
             */
            for (uint i = 1; i <= numEntries; i++) {
                uint[2] memory vestingSchedule = oldRewardEscrow().getVestingScheduleEntry(addressToMigrate, numEntries - i);

                uint time = vestingSchedule[TIME_INDEX];
                uint amount = vestingSchedule[QUANTITY_INDEX];

                /* The list is sorted, when we reach the first entry that can be vested stop */
                if (time < block.timestamp) {
                    break;
                }

                /* import vesting entry */
                _importVestingEntry(
                    addressToMigrate,
                    VestingEntries.VestingEntry({endTime: uint64(time), escrowAmount: amount})
                );

                /* subtract amount from totalBalancePendingMigration - reverts if insufficient */
                totalBalancePendingMigration[addressToMigrate] = totalBalancePendingMigration[addressToMigrate].sub(amount);
            }
        }
    }

    /**
     * Import function for owner to import vesting schedule
     * All entries imported should have past their vesting timestamp and will be ready to be vested
     * Addresses with totalEscrowedAccountBalance == 0 will not be migrated as they have all vested
     */
    function importVestingSchedule(address[] calldata accounts, uint256[] calldata escrowAmounts)
        external
        onlyDuringSetup
        onlyOwner
    {
        require(accounts.length == escrowAmounts.length, "Account and escrowAmounts Length mismatch");

        for (uint i = 0; i < accounts.length; i++) {
            address addressToMigrate = accounts[i];
            uint256 escrowAmount = escrowAmounts[i];

            // ensure account have escrow migration pending
            require(totalEscrowedAccountBalance[addressToMigrate] > 0, "Address escrow balance is 0");
            require(totalBalancePendingMigration[addressToMigrate] > 0, "No escrow migration pending");

            /* Import vesting entry with endTime as block.timestamp and escrowAmount */
            _importVestingEntry(
                addressToMigrate,
                VestingEntries.VestingEntry({endTime: uint64(block.timestamp), escrowAmount: escrowAmount})
            );

            /* update totalBalancePendingMigration - reverts if escrowAmount > remaining balance to migrate */
            totalBalancePendingMigration[addressToMigrate] = totalBalancePendingMigration[addressToMigrate].sub(
                escrowAmount
            );

            emit ImportedVestingSchedule(addressToMigrate, block.timestamp, escrowAmount);
        }
    }

    /**
     * Migration for owner to migrate escrowed and vested account balances
     * Addresses with totalEscrowedAccountBalance == 0 will not be migrated as they have all vested
     */
    function migrateAccountEscrowBalances(
        address[] calldata accounts,
        uint256[] calldata escrowBalances,
        uint256[] calldata vestedBalances
    ) external override onlyDuringSetup onlyOwner {
        require(accounts.length == escrowBalances.length, "Number of accounts and balances don't match");
        require(accounts.length == vestedBalances.length, "Number of accounts and vestedBalances don't match");

        for (uint i = 0; i < accounts.length; i++) {
            address account = accounts[i];
            uint escrowedAmount = escrowBalances[i];
            uint vestedAmount = vestedBalances[i];

            // ensure account doesn't have escrow migration pending / being imported more than once
            require(totalBalancePendingMigration[account] == 0, "Account migration is pending already");

            /* Update totalEscrowedBalance for tracking the DPassive balance of this contract. */
            totalEscrowedBalance = totalEscrowedBalance.add(escrowedAmount);

            /* Update totalEscrowedAccountBalance and totalVestedAccountBalance for each account */
            totalEscrowedAccountBalance[account] = totalEscrowedAccountBalance[account].add(escrowedAmount);
            totalVestedAccountBalance[account] = totalVestedAccountBalance[account].add(vestedAmount);

            /* update totalBalancePendingMigration for account */
            totalBalancePendingMigration[account] = escrowedAmount;

            emit MigratedAccountEscrow(account, escrowedAmount, vestedAmount, now);
        }
    }

    /* Internal function to add entry to vestingSchedules and emit event */
    function _importVestingEntry(address account, VestingEntries.VestingEntry memory entry) internal {
        /* add vesting entry to account and assign an entryID to it */
        uint entryID = BaseRewardEscrowV2._addVestingEntry(account, entry);

        emit ImportedVestingEntry(account, entryID, entry.escrowAmount, entry.endTime);
    }

    /* ========== MODIFIERS ========== */

    modifier systemActive() {
        systemStatus().requireSystemActive();
        _;
    }

    /* ========== EVENTS ========== */
    event MigratedAccountEscrow(address indexed account, uint escrowedAmount, uint vestedAmount, uint time);
    event ImportedVestingSchedule(address indexed account, uint time, uint escrowAmount);
    event ImportedVestingEntry(address indexed account, uint entryID, uint escrowAmount, uint endTime);
    event MigrateEntriesThresholdAmountUpdated(uint newAmount);
}
