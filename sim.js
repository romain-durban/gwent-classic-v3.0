"use strict"

class Controller { }

var nilfgaard_wins_draws = false;

// Makes decisions for the AI opponent player
class ControllerAI {
    constructor(player) {
        this.player = player;
    }

    // Collects data and weighs options before taking a weighted random action
    async startTurn(player) {
        game.gameTracker.startTurn(player);
        if (player.opponent().passed && (player.winning || player.deck.faction === "nilfgaard" && player.total === player.opponent().total)) {
            nilfgaard_wins_draws = player.deck.faction === "nilfgaard" && player.total === player.opponent().total;
            await player.passRound();
            return;
        }
        let data_max = this.getMaximums();
        let data_board = this.getBoardData();
        let weights = player.hand.cards.map(c =>
        ({
            weight: this.weightCard(c, data_max, data_board),
            action: async () => await this.playCard(c, data_max, data_board),
            card: c
        }));
        // If the opponent has passed and is not too far ahead, let's try to take the win
        let diff = player.opponent().total - player.total;
        if (player.opponent().passed && diff < 16) {
            // Looking for a one shot that isn't overkill
            let oneshot = weights.filter(w => (w.card.basePower > diff && w.card.basePower < diff + 5) || (w.weight > diff && w.weight > diff + 5));
            if (oneshot.length > 0) {
                let oneshot_card = oneshot.sort((a, b) => (a.weight - b.weight))[0];
                await oneshot_card.action();
                return;
            }
            // Can we catch up in 2 plays?
            let playable = weights.filter(w => w.weight > 0).sort((a, b) => (b.weight - a.weight));
            if (playable.length > 2)
                playable = playable.slice(0, 2);
            let weightTotal = playable.reduce((a, c) => a + c.weight, 0);
            if (weightTotal > diff) {
                await playable[0].action();
                return;
            }
        }
        if (player.leaderAvailable)
            weights.push({
                name: "Leader Ability",
                weight: this.weightLeader(player.leader, data_max, data_board),
                action: async () => {
                    await player.activateLeader();
                }
            });
        if (player.factionAbilityUses > 0) {
            let factionAbility = factions[player.deck.faction];
            weights.push({
                name: "Faction ability",
                weight: factionAbility.weight(player),
                action: async () => {
                    await player.useFactionAbility();
                }
            });
        }
        weights.push({
            name: "Pass",
            weight: this.weightPass(),
            action: async () => await player.passRound()
        });
        let weightTotal = weights.reduce((a, c) => a + c.weight, 0);
        if (weightTotal === 0) {
            for (let i = 0; i < player.hand.cards.length; ++i) {
                let card = player.hand.cards[i];
                if (card.row === "weather" && this.weightWeather(card) > -1 || card.abilities.includes("avenger")) {
                    await weights[i].action();
                    return;
                }
            }
            await player.passRound();
        } else {
            /*console.log(this.player.tag);
            for (var i = 0; i < weights.length; ++i) {
                if (weights[i].card)
                    console.log("[" + weights[i].card.name + "] Weight: " + weights[i].weight);
                else
                    console.log("[" + weights[i].name + "] Weight: " + weights[i].weight);
            }*/
            let rand = randomInt(weightTotal);
            //console.log("Chosen weight: " + rand);
            for (var i = 0; i < weights.length; ++i) {
                rand -= weights[i].weight;
                if (rand < 0)
                    break;
            }
            //console.log(weights[i]);
            await weights[i].action();
        }
    }

    isSelfRowIndex(i) {
        return (this.player === player_me && i > 2) || (this.player === player_op && i < 3);
    }

    getSelfRowIndexes() {
        if (this.player === player_me)
            return [3, 4, 5];
        return [0, 1, 2];
    }

    // Collects data about card with the hightest power on the board
    getMaximums() {
        let rmax = board.row.map(r => ({
            row: r,
            cards: r.cards.filter(c => c.isUnit()).reduce((a, c) =>
                (!a.length || a[0].power < c.power) ? [c] : a[0].power === c.power ? a.concat([c]) : a, [])
        }));

        let max = rmax.filter((r, i) => r.cards.length && this.isSelfRowIndex(i)).reduce((a, r) => Math.max(a, r.cards[0].power), 0);
        let max_me = rmax.filter((r, i) => this.isSelfRowIndex(i) && r.cards.length && r.cards[0].power === max).reduce((a, r) =>
            a.concat(r.cards.map(c => ({
                row: r,
                card: c
            }))), []);

        max = rmax.filter((r, i) => r.cards.length && !this.isSelfRowIndex(i)).reduce((a, r) => Math.max(a, r.cards[0].power), 0);
        let max_op = rmax.filter((r, i) => !this.isSelfRowIndex(i) && r.cards.length && r.cards[0].power === max).reduce((a, r) =>
            a.concat(r.cards.map(c => ({
                row: r,
                card: c
            }))), []);

        // Also compute for rows without a shield
        let rmax_noshield = rmax.filter((r, i) => !r.row.isShielded());
        let max_noshield = rmax_noshield.filter((r, i) => r.cards.length && this.isSelfRowIndex(i)).reduce((a, r) => Math.max(a, r.cards[0].power), 0);
        let max_me_noshield = rmax_noshield.filter((r, i) => this.isSelfRowIndex(i) && r.cards.length && r.cards[0].power === max_noshield).reduce((a, r) =>
            a.concat(r.cards.map(c => ({
                row: r,
                card: c
            }))), []);

        max_noshield = rmax_noshield.filter((r, i) => r.cards.length && !this.isSelfRowIndex(i)).reduce((a, r) => Math.max(a, r.cards[0].power), 0);
        let max_op_noshield = rmax_noshield.filter((r, i) => !this.isSelfRowIndex(i) && r.cards.length && r.cards[0].power === max_noshield).reduce((a, r) =>
            a.concat(r.cards.map(c => ({
                row: r,
                card: c
            }))), []);

        return {
            rmax: rmax,
            me: max_me,
            op: max_op,
            rmax_noshield: rmax_noshield,
            me_noshield: max_me_noshield,
            op_noshield: max_op_noshield
        };
    }

    // Collects data about the types of cards on the board and in each player's graves
    getBoardData() {
        let data = this.countCards(new CardContainer());
        this.player.getAllRows().forEach(r => this.countCards(r, data));
        data.grave_me = this.countCards(this.player.grave);
        data.grave_op = this.countCards(this.player.opponent().grave);
        return data;
    }

    // Catalogs the kinds of cards in a given CardContainer
    countCards(container, data) {
        data = data ? data : {
            spy: [],
            medic: [],
            bond: {},
            scorch: []
        };
        container.cards.filter(c => c.isUnit()).forEach(c => {
            for (let x of c.abilities) {
                if (!c.isLocked()) {
                    switch (x) {
                        case "spy":
                        case "medic":
                            data[x].push(c);
                            break;
                        case "scorch_r":
                        case "scorch_c":
                        case "scorch_s":
                            data["scorch"].push(c);
                            break;
                        case "bond":
                            if (!data.bond[c.target])
                                data.bond[c.target] = 0;
                            data.bond[c.target]++;
                    }
                }
            }
        });
        return data;
    }

    // Swaps a card from the hand with the deck if beneficial
    redraw() {
        let card = this.discardOrder({
            holder: this.player
        }).shift();
        if (card && card.power < 15) {
            this.player.deck.swap(this.player.hand, this.player.hand.removeCard(card));
        }
    }

    // Orders discardable cards from most to least discardable
    discardOrder(card, src = null) {
        let cards = [];
        let groups = {};
        let source = src ? src : card.holder.hand;

        let musters = source.cards.filter(c => c.abilities.includes("muster"));
        // Grouping Musters together
        musters.forEach(curr => {
            let name = curr.target;
            if (!groups[name])
                groups[name] = [];
            groups[name].push(curr);
        });
        // Keeping one in hand for each muster group 
        for (let group of Object.values(groups)) {
            group.sort(Card.compare);
            group.pop();
            cards.push(...group);
        }

        // Targets of muster that do not have the ability themselves for which we already have the "summoner"
        let tmusters = source.cards.filter(c => Object.keys(groups).includes(c.target) && !c.abilities.includes("muster"));
        cards.push(...tmusters);

        // Discarding randomly weather cards to keep only 1 in hand
        let weathers = source.cards.filter(c => c.row === "weather");
        if (weathers.length > 1) {
            weathers.splice(randomInt(weathers.length), 1);
            cards.push(...weathers);
        }
        // Discarding cards with no abilities by order of strength, unless they are of 7+
        let normal = source.cards.filter(c => c.abilities.length === 0 && c.basePower < 7);
        normal.sort(Card.compare);
        cards.push(...normal);

        // Grouping bonds together
        let bonds = source.cards.filter(c => c.abilities.includes("bond"));
        groups = {};
        bonds.forEach(curr => {
            let name = curr.target;
            if (!groups[name])
                groups[name] = [];
            groups[name].push(curr);
        });
        // Discarding those that are alone and weak (< 6)
        for (let group of Object.values(groups)) {
            if (group.length === 1 && group[0].basePower < 6) {
                cards.push(group[0]);
            }
        }

        return cards;
    }

    // Tells the Player that this object controls to play a card
    async playCard(c, max, data) {
        if (c.key === "spe_horn")
            await this.horn(c);
        else if (c.key === "spe_mardroeme")
            await this.mardroeme(c);
        else if (c.abilities.includes("decoy"))
            await this.decoy(c, max, data);
        else if (c.faction === "special" && c.abilities.includes("scorch"))
            await this.scorch(c, max, data);
        else if (c.faction === "special" && c.abilities.includes("cintra_slaughter"))
            await this.slaughterCintra(c);
        else if (c.faction === "special" && c.abilities.includes("seize"))
            await this.seizeCards(c);
        else if (c.faction === "special" && (c.abilities.includes("shield") || c.abilities.includes("shield_c") || c.abilities.includes("shield_r") || c.abilities.includes("shield_s")))
            await this.shieldCards(c);
        else if (c.faction === "special" && c.abilities.includes("lock"))
            await this.lock(c);
        else if (c.faction === "special" && c.abilities.includes("knockback"))
            await this.knockback(c);
        else if (c.faction === "special" && c.abilities.includes("toussaint_wine"))
            await this.toussaintWine(c);
        else if ((c.isUnit() || c.hero) && c.abilities.includes("witch_hunt"))
            await this.witchHunt(c);
        else if (c.faction === "special" && c.abilities.includes("bank"))
            await this.bank(c);
        else if ((c.isUnit() || c.hero) && c.row === "agile" && (c.abilities.includes("morale") || c.abilities.includes("horn") || c.abilities.includes("bond")))
            await this.player.playCardToRow(c, this.bestAgileRowChange(c).row);
        else
            await this.player.playCard(c);
    }

    // Plays a Commander's Horn to the most beneficial row. Assumes at least one viable row.
    async horn(card) {
        let rows = this.player.getAllRows().filter(r => !r.special.containsCardByKey("spe_horn"));
        let max_row;
        let max = 0;
        for (let i = 0; i < rows.length; ++i) {
            let r = rows[i];
            let dif = [0, 0];
            this.calcRowPower(r, dif, true);
            r.effects.horn++;
            this.calcRowPower(r, dif, false);
            r.effects.horn--;
            let score = dif[1] - dif[0];
            if (max < score) {
                max = score;
                max_row = r;
            }
        }
        await this.player.playCardToRow(card, max_row);
    }

    // Plays a Mardroeme to the most beneficial row. Assumes at least one viable row.
    async mardroeme(card) {
        let row, max = 0;
        this.getSelfRowIndexes().forEach(i => {
            let curr = this.weightMardroemeRow(card, board.row[i]);
            if (curr > max) {
                max = curr;
                row = board.row[i];
            }
        });
        await this.player.playCardToRow(card, row);
    }

    // Selects a card to remove from a Grave. Assumes at least one valid card.
    medic(card, grave) {
        let data = this.countCards(grave);
        let targ;
        if (data.spy.length) {
            let min = data.spy.reduce((a, c) => Math.min(a, c.power), Number.MAX_VALUE);
            targ = data.spy.filter(c => c.power === min)[0];
        } else if (data.medic.length) {
            let max = data.medic.reduce((a, c) => Math.max(a, c.power), 0);
            targ = data.medic.filter(c => c.power === max)[0];
        } else if (data.scorch.length) {
            targ = data.scorch[randomInt(data.scorch.length)];
        } else {
            let units = grave.findCards(c => c.isUnit());
            targ = units.reduce((a, c) => a.power < c.power ? c : a, units[0]);
        }
        return targ;
    }

    // Selects a card to return to the Hand and replaces it with a Decoy. Assumes at least one valid card.
    async decoy(card, max, data) {
        let targ, row;
        if (game.decoyCancelled)
            return;
        let usable_data;
        if (card.row.length > 0) {
            // Units with decoy ability only work on a specific row
            if (card.row === "close" || card.row === "agile")
                usable_data = this.countCards(board.getRow(card, "close", this.player), usable_data);
            if (card.row === "ranged" || card.row === "agile")
                usable_data = this.countCards(board.getRow(card, "ranged", this.player), usable_data);
            if (card.row === "siege")
                usable_data = this.countCards(board.getRow(card, "siege", this.player), usable_data);
        } else {
            usable_data = data;
        }
        if (usable_data.spy.length) {
            let min = usable_data.spy.reduce((a, c) => Math.min(a, c.power), Number.MAX_VALUE);
            targ = usable_data.spy.filter(c => c.power === min)[0];
        } else if (usable_data.medic.length) {
            targ = usable_data.medic[randomInt(usable_data.medic.length)];
        } else if (usable_data.scorch.length) {
            targ = usable_data.scorch[randomInt(usable_data.scorch.length)];
        } else {
            let pairs = max.rmax.filter((r, i) => this.isSelfRowIndex(i) && r.cards.length)
                .filter((r, i) => card.row.length === 0 || (["close", "agile"].includes(card.row) && (i === 2 || i === 3)) || (["ranged", "agile"].includes(card.row) && (i === 1 || i === 4)) || (card.row === "siege" && (i === 0 || i === 5)))
                .reduce((a, r) =>
                    r.cards.map(c => ({
                        r: r.row,
                        c: c
                    })).concat(a), []);

            if (pairs.length) {
                let pair = pairs[randomInt(pairs.length)];
                targ = pair.c;
                row = pair.r;
            }
        }

        if (targ) {
            for (let i = 0; !row; ++i) {
                if (board.row[i].cards.indexOf(targ) !== -1) {
                    row = board.row[i];
                    break;
                }
            }
            targ.decoyTarget = true;
            board.toHand(targ, row);
        } else {
            row = ["close", "agile"].includes(card.row) ? board.getRow(card, "close", this.player) : card.row === "ranged" ? board.getRow(card, "ranged", this.player) : board.getRow(card, "siege", this.player);
        }
        await this.player.playCardToRow(card, row);
    }

    // Tells the controlled Player to play the Scorch card
    async scorch(card, max, data) {
        await this.player.playScorch(card);
    }

    // Tells the controlled Player to play the Scorch card
    async slaughterCintra(card) {
        await this.player.playSlaughterCintra(card);
    }

    // Tells the controlled Player to play the seize special card
    async seizeCards(card) {
        await this.player.playSeize(card);
    }

    // Plays a shield special card to the most beneficial row. Assumes at least one viable row.
    // Also applicable for shield cards which affect only one row.
    async shieldCards(card) {
        if (card.abilities.includes("shield_c")) {
            await this.player.playCardToRow(card, board.getRow(card, "close", this.player));
            return;
        } else if (card.abilities.includes("shield_r")) {
            await this.player.playCardToRow(card, board.getRow(card, "ranged", this.player));
            return;
        } if (card.abilities.includes("shield_s")) {
            await this.player.playCardToRow(card, board.getRow(card, "siege", this.player));
            return;
        }

        let units = card.holder.getAllRowCards().concat(card.holder.hand.cards).filter(c => c.isUnit()).filter(c => !c.abilities.includes("spy"));
        let rowStats = { "close": 0, "ranged": 0, "siege": 0, "agile": 0 };
        units.forEach(c => {
            rowStats[c.row] += c.power;
        });
        rowStats["close"] += rowStats["agile"];
        let max_row;
        if (rowStats["close"] >= rowStats["ranged"] && rowStats["close"] >= rowStats["siege"])
            max_row = board.getRow(card, "close", this.player);
        else if (rowStats["ranged"] > rowStats["close"] && rowStats["ranged"] >= rowStats["siege"])
            max_row = board.getRow(card, "ranged", this.player);
        else
            max_row = board.getRow(card, "siege", this.player);
        await this.player.playCardToRow(card, max_row);
    }

    // Plays the lock special card in the enemy melee row
    async lock(card) {
        await this.player.playCardToRow(card, board.getRow(card, "close", this.player.opponent()));
    }

    // Plays the knockback special card in the most beneficial row - by default enemy melee row
    async knockback(card) {
        await this.player.playKnockback(card);
    }

    // Play special wine card to the most beneficial row.
    async toussaintWine(card) {
        await this.player.playCardToRow(card, this.bestRowToussaintWine(card));
    }

    // Play special wine card to the most beneficial row.
    async witchHunt(card) {
        await this.player.playCardToRow(card, this.bestWitchHuntRow(card).getOppositeRow());
    }

    // Plays the bank special card
    async bank(card) {
        await this.player.playBank(card);
    }

    bestWitchHuntRow(card) {
        if (card.row == "agile") {
            let r = [board.getRow(card, "close", this.player.opponent()), board.getRow(card, "ranged", this.player.opponent())];
            let rows = r.filter(r => !r.isShielded() && !game.scorchCancelled).map(r => ({
                row: r,
                value: r.minUnits().reduce((a, c) => a + c.power, 0)
            }));
            if (rows.length > 0)
                return rows.sort((a, b) => b.value - a.value)[0].row;
            else
                return board.getRow(card, "close", card.holder.opponent())
        } else {
            return board.getRow(card, card.row, card.holder.opponent());
        }
    }

    bestRowToussaintWine(card) {
        let units = card.holder.getAllRowCards().concat(card.holder.hand.cards).filter(c => c.isUnit()).filter(c => !c.abilities.includes("spy"));
        let rowStats = { "close": 0, "ranged": 0, "siege": 0, "agile": 0 };
        units.forEach(c => {
            rowStats[c.row] += 1;
        });
        rowStats["close"] += rowStats["agile"];
        let rows = card.holder.getAllRows();
        rowStats["close"] = board.getRow(card, "close", this.player).effects.toussaint_wine > 0 ? 0 : rowStats["close"];
        rowStats["ranged"] = board.getRow(card, "ranged", this.player).effects.toussaint_wine > 0 ? 0 : rowStats["ranged"];
        rowStats["siege"] = board.getRow(card, "siege", this.player).effects.toussaint_wine > 0 ? 0 : rowStats["siege"];
        let max_row;
        if (rowStats["close"] >= rowStats["ranged"] && rowStats["close"] >= rowStats["siege"])
            max_row = board.getRow(card, "close", this.player);
        else if (rowStats["ranged"] > rowStats["close"] && rowStats["ranged"] >= rowStats["siege"])
            max_row = board.getRow(card, "ranged", this.player);
        else
            max_row = board.getRow(card, "siege", this.player);
        return max_row;
    }

    // Assigns a weight for how likely the conroller is to Pass the round
    weightPass() {
        if (this.player.health === 1)
            return 0;
        let dif = this.player.opponent().total - this.player.total;
        if (dif > 30)
            return 100;
        if (dif < -30 && this.player.opponent().handsize - this.player.handsize > 2)
            return 100;
        return Math.floor(Math.abs(dif));
    }

    // Assigns a weight for how likely the controller is to activate its leader ability
    weightLeader(card, max, data) {
        let w = ability_dict[card.abilities[0]].weight;
        if (ability_dict[card.abilities[0]].weight) {
            let score = w(card, this, max, data);
            return score;
        }
        return 10 + (game.roundCount - 1) * 15;
    }

    // Assigns a weight for how likely the controller will use a scorch-row card
    weightScorchRow(card, max, row_name) {
        if (game.scorchCancelled)
            return 0;
        let index = 3 + (row_name === "close" ? 0 : row_name === "ranged" ? 1 : 2);
        if (this.player === player_me)
            index = 2 - (row_name === "close" ? 0 : row_name === "ranged" ? 1 : 2);
        if (board.row[index].total < 10 || board.row[index].isShielded())
            return 0;
        let score = max.rmax[index].cards.reduce((a, c) => a + c.power, 0);
        return score;
    }

    // Calculates a weight for how likely the controller will use horn on this row
    weightHornRow(card, row) {
        return row.effects.horn ? 0 : this.weightRowChange(card, row);
    }

    // Calculates weight for playing a card on a given row, min 0
    weightRowChange(card, row) {
        return Math.max(0, this.weightRowChangeTrue(card, row));
    }

    bestAgileRowChange(card) {
        let rows = [{ row: board.getRow(card, "close", card.holder), score: 0 }, { row: board.getRow(card, "ranged", card.holder), score: 0 }];
        for (var i = 0; i < 2; i++) {
            rows[i].score = this.weightRowChange(card, rows[i].row);
        }
        return rows.sort((a, b) => b.score - a.score)[0];
    }

    // Calculates weight for playing a card on the given row
    weightRowChangeTrue(card, row) {
        let dif = [0, 0];
        this.calcRowPower(row, dif, true);
        row.updateState(card, true);
        this.calcRowPower(row, dif, false);
        if (!card.isSpecial())
            dif[0] -= row.calcCardScore(card);
        row.updateState(card, false);
        return dif[1] - dif[0];
    }

    // Calculates the weight for playing a weather card
    weightWeather(card) {
        let rows;
        if (card.abilities) {
            if (card.key === "spe_clear")
                rows = Object.values(weather.types).filter(t => t.count > 0).flatMap(t => t.rows);
            else
                rows = Object.values(weather.types).filter(t => t.count === 0 && t.name === card.abilities[0]).flatMap(t => t.rows);
        } else {
            if (card.ability == "clear")
                rows = Object.values(weather.types).filter(t => t.count > 0).flatMap(t => t.rows);
            else
                rows = Object.values(weather.types).filter(t => t.count === 0 && t.name === card.ability).flatMap(t => t.rows);
        }

        if (!rows.length)
            return 1;
        let dif = [0, 0];
        rows.forEach(r => {
            let state = r.effects.weather;
            this.calcRowPower(r, dif, true);
            r.effects.weather = !state;
            this.calcRowPower(r, dif, false);
            r.effects.weather = state;
        });
        return dif[1] - dif[0];
    }

    // Calculates the weight for playing a mardroeme card
    weightMardroemeRow(card, row) {
        if (card.key === "spe_mardroeme" && row.special.containsCardByKey("spe_mardroeme"))
            return 0;
        let ermion = card.holder.hand.cards.filter(c => c.key === "sk_ermion").length > 0;
        if (ermion && card.key !== "sk_ermion" && row === board.getRow(card, "ranged", this.player))
            return 0;
        let bers_cards = row.cards.filter(c => c.abilities.includes("berserker"));
        let weightData = { bond: {}, strength: 0, scorch: 0 };

        for (var i = 0; i < bers_cards.length; i++) {
            let c = bers_cards[i];
            let ctarget = card_dict[c.target];
            weightData.strength -= c.power;
            if (ctarget.ability.includes("morale"))
                weightData.strength += Number(ctarget["strength"]) + row.cards.filter(c => c.isUnit()).length - 1;
            if (ctarget.ability.includes("bond")) {
                if (!weightData.bond[c.target])
                    weightData.bond[c.target] = [0, Number(ctarget["strength"])];
                weightData.bond[c.target][0]++;
            }
            if (ctarget.ability.includes("scorch_c"))
                weightData.scorch += this.weightScorchRow(card, this.getMaximums(), "close");
        }
        let weight = weightData.strength + Object.keys(weightData.bond).reduce((s, c) => s + Math.pow(weightData.bond[c][0], 2) * weightData.bond[c][1], 0) + weightData.scorch;
        return Math.max(1, weight);
    }

    // Calculates the weight for cards with the medic ability
    weightMedic(data, score, owner) {
        let units = owner.grave.findCards(c => c.isUnit());
        let grave = data["grave_" + owner.opponent().tag];
        return !units.length ? Math.min(1, score) : score + (grave.spy.length ? 50 : grave.medic.length ? 15 : grave.scorch.length ? 10 : this.player.health === 1 ? 1 : 0);
    }

    // Calculates the weight for cards with the berserker ability
    weightBerserker(card, row, score) {
        if (card.holder.hand.cards.filter(c => c.abilities.includes("mardroeme")).length < 1 && !row.effects.mardroeme > 0)
            return score;
        score -= card.basePower;
        let ctarget = card_dict[card.target];
        if (ctarget.ability.includes("morale")) {
            score += Number(ctarget["strength"]) + row.cards.filter(c => c.isUnit()).length - 1;
        }
        else if (ctarget.ability.includes("bond")) {
            let n = 1;
            if (!row.effects.mardroeme)
                n += row.cards.filter(c => c.key === card.key).filter(c => !c.isLocked()).length;
            else
                n += row.cards.filter(c => c.key === card.target).filter(c => !c.isLocked()).length;
            score += Number(ctarget["strength"]) * (n * n);
        } else if (ctarget.ability.includes("scorch_c")) {
            score += this.weightScorchRow(card, this.getMaximums(), "close");
        } else {
            score += Number(ctarget["strength"]);
        }
        return Math.max(1, score);
    }

    // Calculates the weight for a weather card if played from the deck
    weightWeatherFromDeck(card, weather_id) {
        if (card.holder.deck.findCard(c => c.abilities.includes(weather_id)) === undefined)
            return 0;
        return this.weightCard({
            abilities: [weather_id],
            row: "weather"
        });
    }

    // Assigns a weights for how likely the controller with play a card from its hand
    weightCard(card, max, data) {
        let abi
        if (card.abilities) {
            abi = card.abilities;
        } else if (card["ability"]) {
            abi = card["ability"].split(" ");
        } else {
            abi = [];
            console.log("Missing abilities for card:");
            console.log(card);
        }
        if (abi.includes("decoy")) {
            if (card.row.length > 0) {
                let row_data;
                if (card.row === "close" || card.row === "agile")
                    row_data = this.countCards(board.getRow(card, "close", this.player), row_data);
                if (card.row === "ranged" || card.row === "agile")
                    row_data = this.countCards(board.getRow(card, "ranged", this.player), row_data);
                if (card.row === "siege")
                    row_data = this.countCards(board.getRow(card, "siege", this.player), row_data);
                return game.decoyCancelled ? 0 : row_data.spy.length ? 50 : row_data.medic.length ? 15 : row_data.scorch.length ? 10 : max.me.length ? card.power : 0;
            } else
                return game.decoyCancelled ? 0 : data.spy.length ? 50 : data.medic.length ? 15 : data.scorch.length ? 10 : max.me.length ? 1 : 0;
        }
        if (abi.includes("horn")) {
            let rows = this.player.getAllRows().filter(r => !r.special.containsCardByKey("spe_horn"));
            if (!rows.length)
                return 0;
            rows = rows.map(r => this.weightHornRow(card, r));
            return Math.max(...rows) / 2;
        }

        if (abi) {
            if (abi.includes("scorch")) {
                if (game.scorchCancelled)
                    return Math.max(0, card.power);
                let power_op = max.op_noshield.length ? max.op_noshield[0].card.power : 0;
                let power_me = max.me_noshield.length ? max.me_noshield[0].card.power : 0;
                let total_op = power_op * max.op_noshield.length;
                let total_me = power_me * max.me_noshield.length;
                return power_me > power_op ? 0 : power_me < power_op ? total_op : Math.max(0, total_op - total_me);
            }
            if (abi.includes("decoy")) {
                return game.decoyCancelled ? 0 : data.spy.length ? 50 : data.medic.length ? 15 : data.scorch.length ? 10 : max.me.length ? 1 : 0;
            }
            if (abi.includes("mardroeme")) {
                let rows = this.player.getAllRows();
                return Math.max(...rows.map(r => this.weightMardroemeRow(card, r)));
            }
            if (["cintra_slaughter", "seize", "lock", "shield", "knockback", "shield_c", "shield_r", "shield_s","bank"].includes(abi.at(-1))) {
                return ability_dict[abi.at(-1)].weight(card);
            }
            if (abi.includes("witch_hunt")) {
                if (game.scorchCancelled)
                    return card.power;
                let best_row = this.bestWitchHuntRow(card)
                if (best_row) {
                    let dmg = best_row.minUnits().reduce((a, c) => a + c.power, 0);
                    if (dmg < 6)    // Let's not waste it on isolated weak units
                        dmg = 0;
                    return dmg + card.power;
                }
                return card.power
            }
            if (abi.includes("toussaint_wine")) {
                let units = card.holder.getAllRowCards().concat(card.holder.hand.cards).filter(c => c.isUnit()).filter(c => !c.abilities.includes("spy"));
                let rowStats = { "close": 0, "ranged": 0, "siege": 0, "agile": 0 };
                units.forEach(c => {
                    rowStats[c.row] += 1;
                });
                rowStats["close"] += rowStats["agile"];
                let rows = card.holder.getAllRows();
                rowStats["close"] = board.getRow(card, "close", this.player).effects.toussaint_wine > 0 ? 0 : rowStats["close"];
                rowStats["ranged"] = board.getRow(card, "ranged", this.player).effects.toussaint_wine > 0 ? 0 : rowStats["ranged"];
                rowStats["siege"] = board.getRow(card, "siege", this.player).effects.toussaint_wine > 0 ? 0 : rowStats["siege"];
                return 2 * Math.max(rowStats["close"], rowStats["ranged"], rowStats["siege"]);
            }
            if (abi.at(-1) && abi.at(-1).startsWith("witcher_")) {
                let witchers = card.holder.getAllRowCards().filter(c => c.abilities.includes(abi.at(-1)));
                let keep = witchers.filter(c => c.hero);
                return card.power + (2 * witchers.length * 2) + (keep.length > 0 ? keep[0].power : 0);
            }
            if (abi.includes("inspire")) {
                let insp = card.holder.getAllRowCards().filter(c => c.abilities.includes("inspire"));
                let best_power = 0;
                if (insp.length > 0)
                    best_power = insp.sort((a, b) => b.power - a.power)[0].power;
                let max_power = Math.max(card.power, best_power);
                if (card.power === max_power)
                    return max_power + insp.map(c => max_power - c.power).reduce((a, c) => a + c, 0);
                return max_power;
            }
        }

        if (card.row === "weather" || (card.deck && card.deck.startsWith("weather"))) {
            return Math.max(0, this.weightWeather(card));
        }

        let row = board.getRow(card, card.row === "agile" ? "close" : card.row, this.player);
        let score = row.calcCardScore(card);
        switch (abi[abi.length - 1]) {
            case "bond":
            case "morale":
            case "horn":
                score = card.row === "agile" ? this.bestAgileRowChange(card).score : this.weightRowChange(card, row);
                break;
            case "medic":
                score = this.weightMedic(data, score, card.holder);
                break;
            case "spy":
                score = 15 + score;
                break;
            case "muster":
                let pred = c => c.target === card.target;
                let units = card.holder.hand.cards.filter(pred).concat(card.holder.deck.cards.filter(pred));
                score *= units.length;
                break;
            case "scorch_c":
                score = Math.max(1, this.weightScorchRow(card, max, "close"));
                break;
            case "scorch_r":
                score = Math.max(1, this.weightScorchRow(card, max, "ranged"));
                break;
            case "scorch_s":
                score = Math.max(1, this.weightScorchRow(card, max, "siege"));
                break;
            case "berserker":
                score = this.weightBerserker(card, row, score);
                break;
            case "avenger":
            case "avenger_kambi":
            case "whorshipper":
                return score + ability_dict[abi.at(-1)].weight(card);
        }

        return score;
    }

    // Calculates the current power of a row associated with each Player
    calcRowPower(r, dif, add) {
        r.findCards(c => c.isUnit()).forEach(c => {
            let p = r.calcCardScore(c);
            c.holder === this.player ? (dif[0] += add ? p : -p) : (dif[1] += add ? p : -p);
        });
    }
}

var may_leader = true,
    exibindo_lider = false;

// Can make actions during turns like playing cards that it owns
class Player {
    constructor(id, name, deck, isAI = true) {
        this.id = id;
        this.tag = (id === 0) ? "me" : "op";
        //this.controller = (id === 0) ? new Controller() : new ControllerAI(this);
        if (isAI) {
            this.controller = new ControllerAI(this);
        } else {
            this.controller = new Controller();
        }

        if (game.fullAI) {
            this.hand = (id === 0) ? new Hand(null, this.tag) : new Hand(null, this.tag);
        } else {
            this.hand = (id === 0) ? new Hand(null, this.tag) : new HandAI(this.tag);
        }
        this.grave = new Grave(document.getElementById("grave-" + this.tag));
        this.deck = new Deck(deck.faction, document.getElementById("deck-" + this.tag));
        this.deck_data = deck;
        this.leader = new Card(deck.leader.index, deck.leader.card, this);

        this.reset();

        this.name = name;
    }

    // Sets default values
    reset() {
        this.grave.reset();
        this.hand.reset();
        this.deck.reset();
        this.deck.initializeFromID(this.deck_data.cards, this);

        this.health = 2;
        this.total = 0;
        this.passed = false;
        this.handsize = 10;
        this.winning = false;
        this.factionAbilityUses = 0;
        this.effects = {
            "witchers": {},
            "whorshippers": 0,
            "inspire": 0
        };

        // Handling Faction abilities: active or passive
        let factionAbility = factions[this.deck.faction];
        if (factionAbility["activeAbility"]) {
            // Init ability if need be
            if (factionAbility.factionAbilityInit) {
                factionAbility.factionAbilityInit(this);
            }
            this.updateFactionAbilityUses(factionAbility["abilityUses"]);
        }

        this.enableLeader();
        this.setPassed(false);
    }

    roundStartReset() {
        this.effects = {
            "witchers": {},
            "whorshippers": 0,
            "inspire": 0
        };
    }

    // Returns the opponent Player
    opponent() {
        return board.opponent(this);
    }

    // Updates the player's total score and notifies the gamee
    updateTotal(n) {
        this.total += n;
        board.updateLeader();
    }

    // Puts the player in the winning state
    setWinning(isWinning) {
        this.winning = isWinning;
    }

    // Puts the player in the passed state
    setPassed(hasPassed) {
        this.passed = hasPassed;
    }

    // Sets up board for turn
    async startTurn() {
        if (this.controller instanceof ControllerAI) {
            await this.controller.startTurn(this);
        }
    }

    // Passes the round and ends the turn
    async passRound() {
        this.setPassed(true);
        game.gameTracker.getCurrentTurn().passAction();
        await this.endTurn();
    }

    // Plays a scorch card
    async playScorch(card) {
        if (!game.scorchCancelled) {
            game.gameTracker.getCurrentTurn().playSpecialCardBoard(card);
            await this.playCardAction(card, async () => await ability_dict["scorch"].activated(card));
        }
    }

    // Plays a Slaughter of Cintra card
    async playSlaughterCintra(card) {
        game.gameTracker.getCurrentTurn().playSpecialCardBoard(card);
        await this.playCardAction(card, async () => await ability_dict["cintra_slaughter"].activated(card));
    }

    // Plays a Seize special card card
    async playSeize(card) {
        game.gameTracker.getCurrentTurn().playSpecialCard(card, board.getRow(card, "close", this.opponent()));
        await this.playCardAction(card, async () => await ability_dict["seize"].activated(card));
    }

    // Plays a Knockback special card card, assuming 1 valid
    async playKnockback(card) {
        let best_row = board.getRow(card, "close", this.opponent());
        //If melee row is empty, better target ranged
        if (board.getRow(card, "close", this.opponent()).cards.length === 0)
            best_row = board.getRow(card, "ranged", this.opponent());
        // If siege has an active weather effect, better target ranged
        if (board.getRow(card, "ranged", this.opponent()).cards.length > 1 && board.getRow(card, "siege", this.opponent()).effects.weather)
            best_row = board.getRow(card, "ranged", this.opponent());
        // If ranged has a horn or shield effect, better target it
        if ((board.getRow(card, "ranged", this.opponent()).isShielded() || board.getRow(card, "ranged", this.opponent()).effects.horn > 0) && board.getRow(card, "ranged", this.opponent()).cards.length > 0)
            best_row = board.getRow(card, "ranged", this.opponent());
        // If there are some bond units in the ranged row, better try to break it before it grows
        if (Object.keys(board.getRow(card, "ranged", this.opponent()).effects.bond).length > 0 && board.getRow(card, "siege", this.opponent()).effects.horn === 0)
            best_row = board.getRow(card, "ranged", this.opponent());
        game.gameTracker.getCurrentTurn().playSpecialCard(card, best_row);
        await this.playCardAction(card, async () => await ability_dict["knockback"].activated(card, best_row));
    }

    // Play the bank card
    async playBank(card) {
        game.gameTracker.getCurrentTurn().playSpecialCardBoard(card);
        await this.playCardAction(card, async () => await ability_dict["bank"].activated(card));
    }

    // Plays a card to a specific row
    async playCardToRow(card, row) {
        if (row instanceof Weather)
            game.gameTracker.getCurrentTurn().playWeatherCard(card);
        else if (card.isUnit() || card.hero)
            game.gameTracker.getCurrentTurn().playUnitCard(card, row);
        else
            game.gameTracker.getCurrentTurn().playSpecialCard(card, row);
        await this.playCardAction(card, async () => await board.moveTo(card, row, this.hand));
    }

    // Plays a card to the board
    async playCard(card) {
        let rowType = (card.row === "agile") ? "close" : card.row ? card.row : "close";
        let row = board.getRow(card, rowType, this);
        if (row instanceof Weather) 
            game.gameTracker.getCurrentTurn().playWeatherCard(card);
        else if (card.isUnit() || card.hero)
            game.gameTracker.getCurrentTurn().playUnitCard(card, row);
        else
            game.gameTracker.getCurrentTurn().playSpecialCard(card, row);
        await this.playCardAction(card, async () => await card.autoplay(this.hand));
    }

    // Shows a preview of the card being played, plays it to the board and ends the turn
    async playCardAction(card, action) {
        ui.showPreviewVisuals(card);
        ui.hidePreview(card);
        await action();
        await this.endTurn();
    }

    // Handles end of turn visuals and behavior the notifies the game
    async endTurn() {
        if (!this.passed && !this.canPlay()) {
            this.setPassed(true);
        }
        await game.endTurn();
    }

    // Tells the the Player if it won the round. May damage health.
    endRound(win) {
        if (!win) {
            if (this.health < 1)
                return;
            this.health--;
        }
        this.setPassed(false);
        this.setWinning(false);
    }

    // Returns true if the Player can make any action other than passing
    canPlay() {
        return this.hand.cards.length > 0 || this.leaderAvailable || this.factionAbilityUses > 0;
    }

    // Use a leader's Activate ability, then disable the leader
    async activateLeader() {
        if (this.leaderAvailable) {
            this.endTurnAfterAbilityUse = true;
            await this.leader.activated[0](this.leader, this);
            this.disableLeader();
            // Some abilities require further actions before ending the turn, such as selecting a card
            if (this.endTurnAfterAbilityUse) {
                game.gameTracker.getCurrentTurn().useLeader(this.leader);
                await this.endTurn();
            }  else {
                // Make selections for AI player
                if (this.controller instanceof ControllerAI) {
                    if (this.leader.key === "wu_alzur_maker") {
                        let worse_unit = this.getAllRowCards().filter(c => c.isUnit()).sort((a, b) => a.power - b.power)[0];
                        game.gameTracker.getCurrentTurn().useLeader(this.leader,worse_unit);
                        await ui.selectCard(worse_unit);
                    } else if (this.leader.key === "to_anna_henrietta_duchess") {
                        let horns = player_me.getAllRows().filter(r => r.special.findCards(c => c.abilities.includes("horn")).length > 0).sort((a, b) => b.total - a.total);
                        if (horns[0]) {
                            game.gameTracker.getCurrentTurn().useLeader(this.leader, horns[0]);
                            await ui.selectRow(horns[0]);
                        }
                    } else if (this.leader.key === "lr_meve_princess" || this.leader.key === "sy_carlo_varese") {
                        let max = this.controller.getMaximums();
                        let rows = [this.controller.weightScorchRow(this.leader, max, "close"), this.controller.weightScorchRow(this.leader, max, "ranged"), this.controller.weightScorchRow(this.leader, max, "siege")];
                        let maxv = 0, max_row;
                        let offset = 3;
                        if (this === player_me) {
                            offset = 0;
                            rows = rows.reverse();
                        }
                        for (var i = 0; i < 3; i++) {
                            if (rows[i] > maxv) {
                                maxv = rows[i];
                                max_row = board.row[offset + i];
                            }
                        }
                        if (max_row) {
                            game.gameTracker.getCurrentTurn().useLeader(this.leader, max_row);
                            await ui.selectRow(max_row);
                        }
                    } else if (this.leader.key === "sy_cyrus_hemmelfart") {
                        // We select a random row to put shackles on
                        let offset = 3;
                        if (this === player_me)
                            offset = 0;
                        let r = board.row[offset + randomInt(2)];
                        game.gameTracker.getCurrentTurn().useLeader(this.leader,r);
                        await ui.selectRow(r);
                    }
                }
            }
        }
    }

    // Disable access to leader ability and toggles leader visuals to off state
    disableLeader() {
        this.leaderAvailable = false;
    }

    // Enable access to leader ability and toggles leader visuals to on state
    enableLeader() {
        this.leaderAvailable = this.leader.activated.length > 0;
    }

    async useFactionAbility() {
        let factionData = factions[this.deck.faction];
        if (factionData.activeAbility && this.factionAbilityUses > 0) {
            this.endTurnAfterAbilityUse = true;
            await factionData.factionAbility(this);
            this.updateFactionAbilityUses(this.factionAbilityUses - 1);
            // Some faction abilities require extra interractions
            if (this.endTurnAfterAbilityUse) {
                await this.endTurn();
            } else {
                if (this.controller instanceof ControllerAI) {
                    if (this.deck.faction === "lyria_rivia") {
                        let best_row = this.controller.bestRowToussaintWine(ui.previewCard); // Reusing bestRowToussaintWine because it is nearly the same principle
                        await ui.selectRow(best_row, true);
                    }
                }
            }
        }
        return;
    }

    updateFactionAbilityUses(count) {
        this.factionAbilityUses = Math.max(0, count);
    }

    // Get all rows for this player, sorted to have close > ranged > siege
    getAllRows() {
        if (this === player_me) {
            return board.row.filter((r, i) => i > 2);
        }
        return board.row.filter((r, i) => i < 3).reverse();
    }

    //Get all cards in rows for this player
    getAllRowCards() {
        return this.getAllRows().reduce((a, r) => r.cards.concat(a), []);
    }
}

// Handles the adding, removing and formatting of cards in a container
class CardContainer {
    constructor() {
        this.cards = [];
    }

    // Indicates whether or not this container contains any card
    isEmpty() {
        return this.cards.length === 0;
    }

    // Returns the first card that satisfies the predcicate. Does not modify container.
    findCard(predicate) {
        for (let i = this.cards.length - 1; i >= 0; --i)
            if (predicate(this.cards[i]))
                return this.cards[i];
    }

    // Returns a list of cards that satisfy the predicate. Does not modify container.
    findCards(predicate) {
        return this.cards.filter(predicate);
    }

    // Indicates whether or not the card with given Key can be found in container
    containsCardByKey(key) {
        return (this.findCards(c => c.key === key).length) > 0;
    }

    // Returns a list of up to n cards that satisfy the predicate. Does not modify container.
    findCardsRandom(predicate, n) {
        let valid = predicate ? this.cards.filter(predicate) : this.cards;
        if (valid.length === 0)
            return [];
        if (!n || n === 1)
            return [valid[randomInt(valid.length)]];
        let out = [];
        for (let i = Math.min(n, valid.length); i > 0; --i) {
            let index = randomInt(valid.length);
            out.push(valid.splice(index, 1)[0]);
        }
        return out;
    }

    // Removes and returns a list of cards that satisy the predicate.
    getCards(predicate) {
        return this.cards.reduce((a, c, i) => (predicate(c, i) ? [i] : []).concat(a), []).map(i => this.removeCard(i));
    }

    // Removes and returns a card that satisfies the predicate.
    getCard(predicate) {
        for (let i = this.cards.length - 1; i >= 0; --i)
            if (predicate(this.cards[i]))
                return this.removeCard(i);
    }

    // Removes and returns any cards up to n that satisfy the predicate.
    getCardsRandom(predicate, n) {
        return this.findCardsRandom(predicate, n).map(c => this.removeCard(c));
    }

    // Adds a card to the container along with its associated HTML element.
    addCard(card, index) {
        this.cards.push(card);
        card.currentLocation = this;
    }

    // Removes a card from the container along with its associated HTML element.
    removeCard(card, index) {
        if (this.cards.length === 0)
            return card;
        card = this.cards.splice(isNumber(card) ? card : this.cards.indexOf(card), 1)[0];
        return card;
    }

    // Adds a card to a pre-sorted CardContainer
    addCardSorted(card) {
        let i = this.getSortedIndex(card);
        this.cards.splice(i, 0, card);
        return i;
    }

    // Returns the expected index of a card in a sorted CardContainer
    getSortedIndex(card) {
        for (var i = 0; i < this.cards.length; ++i)
            if (Card.compare(card, this.cards[i]) < 0)
                break;
        return i;
    }

    // Adds a card to a random index of the CardContainer
    addCardRandom(card) {
        this.cards.push(card);
        let index = randomInt(this.cards.length);
        if (index !== this.cards.length - 1) {
            let t = this.cards[this.cards.length - 1];
            this.cards[this.cards.length - 1] = this.cards[index];
            this.cards[index] = t;
        }
        return index;
    }

    // Empty function to be overried by subclasses that resize their content
    resize() { }

    // Returns the container to its default, empty state
    reset() {
        while (this.cards.length)
            this.removeCard(0);
        this.cards = [];
    }

}

// Contians all used cards in the order that they were discarded
class Grave extends CardContainer {
    constructor() {
        super()
    }

    // Override
    addCard(card) {
        super.addCard(card, this.cards.length);
    }

    // Override
    removeCard(card) {
        let n = isNumber(card) ? card : this.cards.indexOf(card);
        return super.removeCard(card, n);
    }
}

// Contians all special cards for a given row
class RowSpecial extends CardContainer {
    constructor(elem, row) {
        super()
        this.row = row;
    }

    // Override
    addCard(card) {
        super.addCard(card, this.cards.length);
    }

    // Override
    removeCard(card) {
        let n = isNumber(card) ? card : this.cards.indexOf(card);
        if (card.removed) {
            for (let x of card.removed)
                x(card);
        }
        return super.removeCard(card, n);
    }

}

// Contains a randomized set of cards to be drawn from
class Deck extends CardContainer {
    constructor(faction) {
        super();
        this.faction = faction;
    }

    // Creates duplicates of cards with a count of more than one, then initializes deck
    initializeFromID(card_id_list, player) {
        this.initialize(card_id_list.reduce((a, c) => a.concat(clone(c.count, c)), []), player);

        function clone(n, elem) {
            for (var i = 0, a = []; i < n; ++i) a.push(elem);
            return a;
        }
    }

    // Populates a this deck with a list of card data and associated those cards with the owner of this deck.
    initialize(card_data_list, player) {
        for (let i = 0; i < card_data_list.length; ++i) {
            let card = new Card(card_data_list[i].index, card_dict[card_data_list[i].index], player);
            card.holder = player;
            this.addCardRandom(card);
        }
    }

    // Override
    addCard(card) {
        this.addCardRandom(card);
    }

    // Sends the top card to the passed hand
    async draw(hand) {
        if (hand === player_op.hand)
            hand.addCard(this.removeCard(0));
        else
            await board.toHand(this.cards[0], this);
    }

    // Draws a card and sends it to the container before adding a card from the container back to the deck.
    swap(container, card) {
        container.addCard(this.removeCard(0));
        this.addCard(card);
    }

    // Override
    resize() {

    }

    // Override
    reset() {
        super.reset();
    }
}

// Hand used by computer AI. Has an offscreen HTML element for card transitions.
class HandAI extends CardContainer {
    constructor(tag) {
        super(undefined, tag);
    }
    resize() {

    }
}

// Hand used by current player
class Hand extends CardContainer {
    constructor(elem, tag) {
        super();
        this.tag = tag;
    }

    // Override
    addCard(card) {
        let i = this.addCardSorted(card);
    }

    // Override
    resize() {

    }
}

// Contains active cards and effects. Calculates the current score of each card and the row.
class Row extends CardContainer {
    constructor() {
        super();
        this.special = new RowSpecial(null, this);
        this.total = 0;
        this.effects = {
            weather: false,
            bond: {},
            morale: 0,
            horn: 0,
            mardroeme: 0,
            shield: 0,
            lock: 0,
            toussaint_wine: 0
        };
        this.halfWeather = false;
    }

    // Override
    async addCard(card, runEffect = true) {
        if (card.isSpecial()) {
            this.special.addCard(card);
        } else {
            let index = this.addCardSorted(card);
            this.resize();
        }
        card.currentLocation = this;
        if (this.effects.lock && card.isUnit() && card.abilities.length) {
            card.locked = true;
            this.effects.lock = Math.max(this.effects.lock - 1, 0);
            let lock_card = this.special.findCard(c => c.abilities.includes("lock"));
            // If several units arrive at the same time, it can be triggered several times, so we first remove the lock before doing animations
            if (lock_card)
                await board.toGrave(lock_card, this.special);
        }
        if (runEffect && !card.isLocked()) {
            this.updateState(card, true);
            for (let x of card.placed)
                await x(card, this);
        }
        //this.updateScore();
        // Let's update all rows for better accuracy
        board.updateScores();
    }

    // Override
    removeCard(card, runEffect = true) {
        if (isNumber(card) && card === -1) {
            card = this.special.cards[0];
            this.special.reset();
            return card;
        }
        card = isNumber(card) ? this.cards[card] : card;
        if (card.isSpecial()) {
            this.special.removeCard(card);
        } else {
            super.removeCard(card);
            card.resetPower();
            card.locked = false;
        }
        this.updateState(card, false);
        if (runEffect) {
            if (!card.decoyTarget) {
                for (let x of card.removed)
                    x(card);
            } else {
                card.decoyTarget = false;
            }

        }
        this.updateScore();
        return card;
    }

    // Updates a card's effect on the row
    updateState(card, activate) {
        for (let x of card.abilities) {
            if (!card.isLocked()) {
                switch (x) {
                    case "morale":
                    case "horn":
                    case "mardroeme":
                    case "lock":
                    case "toussaint_wine":
                        this.effects[x] += activate ? 1 : -1;
                        break;
                    case "shield":
                    case "shield_c":
                    case "shield_r":
                    case "shield_s":
                        this.effects["shield"] += activate ? 1 : -1;
                        break;
                    case "bond":
                        if (!this.effects.bond[card.target])
                            this.effects.bond[card.target] = 0;
                        this.effects.bond[card.target] += activate ? 1 : -1;
                        break;
                }
            }
        }
    }

    // Activates weather effect and visuals
    addOverlay(overlay) {
        this.effects.weather = true;
        this.updateScore();
    }

    // Deactivates weather effect and visuals
    removeOverlay(overlay) {
        this.effects.weather = false;
        this.updateScore();
    }

    // Override
    resize() {

    }

    // Updates the row's score by summing the current power of its cards
    updateScore() {
        let total = 0;
        for (let card of this.cards) {
            total += this.cardScore(card);
        }
        
        let player = this.getRowIndex() < 3 ? player_op : player_me;
        player.updateTotal(total - this.total);
        this.total = total;
    }

    // Calculates and set the card's current power
    cardScore(card) {
        let total = this.calcCardScore(card);
        card.setPower(total);
        return total;
    }

    // Calculates the current power of a card affected by row affects
    calcCardScore(card) {
        if (card.key === "spe_decoy")
            return 0;
        let total = card.basePower;
        if (card.hero)
            return total;
        if (card.abilities.includes("spy"))
            total = Math.floor(game.spyPowerMult * total);
        // Inspire - changes base strength, before weather
        if (card.abilities.includes("inspire") && !card.isLocked()) {
            let inspires = card.holder.getAllRowCards().filter(c => !c.isLocked() && c.abilities.includes("inspire"));
            if (inspires.length > 1) {
                let maxBase = inspires.reduce((a, b) => a.basePower > b.basePower ? a : b);
                total = maxBase.basePower;
            }
        }
        if (this.effects.weather)
            if (this.halfWeather)
                total = Math.max(Math.min(1, total), Math.floor(total / 2));  // 2 special cases, if intially 1, we want to keep one, not 0 (floor(0.5)). If 0, we want to keep 0, not 1
            else
                total = Math.min(1, total);
        // Bond
        let bond = this.effects.bond[card.target];
        if (isNumber(bond) && bond > 1 && !card.isLocked())
            total *= Number(bond);
        // Morale
        total += Math.max(0, this.effects.morale + (card.abilities.includes("morale") ? -1 : 0));
        // Toussiant Wine
        total += Math.max(0, 2 * this.effects.toussaint_wine);
        // Witcher Schools
        if (card.abilities.at(-1) && card.abilities.at(-1).startsWith("witcher_") && !card.isLocked()) {
            let school = card.abilities.at(-1);
            if (card.holder.effects["witchers"][school]) {
                total += (card.holder.effects["witchers"][school] - 1) * 2;
            }
        }
        // Whorshipped
        if (card.abilities.includes("whorshipped") && card.holder.effects["whorshippers"] > 0 && !card.isLocked())
            total += card.holder.effects["whorshippers"] * game.whorshipBoost;
        // Horn
        if (this.effects.horn - (card.abilities.includes("horn") ? 1 : 0) > 0)
            total *= 2;
        return total;
    }

    // Applies a temporary leader horn affect that is removed at the end of the round
    async leaderHorn(card) {
        if (this.special.containsCardByKey("spe_horn"))
            return;
        let horn = new Card("spe_horn", card_dict["spe_horn"], card.holder);
        await this.addCard(horn);
        game.roundEnd.push(() => this.removeCard(horn));
    }

    // Applies a local scorch effect to this row
    async scorch() {
        if (this.total >= 10 && !this.isShielded() && !game.scorchCancelled)
            await Promise.all(this.maxUnits().map(async c => {
                await board.toGrave(c, this);
            }));
    }

    // Removes all cards and effects from this row
    clear() {
        this.special.cards.filter(c => !c.noRemove).forEach(async c => await board.toGrave(c, this));
        this.cards.filter(c => !c.noRemove).forEach(async c => await board.toGrave(c, this));
    }

    // Returns all regular unit cards with the heighest power
    maxUnits() {
        let max = [];
        for (let i = 0; i < this.cards.length; ++i) {
            let card = this.cards[i];
            if (!card.isUnit())
                continue;
            if (!max[0] || max[0].power < card.power)
                max = [card];
            else if (max[0].power === card.power)
                max.push(card);
        }
        return max;
    }

    minUnits() {
        let min = [];
        for (let i = 0; i < this.cards.length; ++i) {
            let card = this.cards[i];
            if (!card.isUnit())
                continue;
            if (!min[0] || min[0].power > card.power)
                min = [card];
            else if (min[0].power === card.power)
                min.push(card);
        }
        return min;
    }

    // Override
    reset() {
        super.reset();
        this.special.reset();
        this.total = 0;
        this.effects = {
            weather: false,
            bond: {},
            morale: 0,
            horn: 0,
            mardroeme: 0,
            shield: 0,
            lock: 0,
            toussaint_wine: 0
        };
    }

    // Indicates whether or not a shield is protecting that row from abilities (does not protect from weather effects though)
    isShielded() {
        return (this.effects.shield > 0);
    }

    // True if at least 1 unit and total of power >= 10
    canBeScorched() {
        if (game.scorchCancelled)
            return false;
        return (this.cards.reduce((a, c) => a + c.power, 0) >= 10) && (this.cards.filter(c => c.isUnit()).length > 0);
    }

    // Return the index of the current row in the list of rows on the board
    getRowIndex() {
        for (let i = 0; i < board.row.length; i++) {
            if (board.row[i] === this)
                return i;
        }
        return -1;
    }

    // Returns the opposite Row object - the one on the opponent's side of the field
    getOppositeRow() {
        let index = 5 - this.getRowIndex();
        if (index >= 0 && index < board.row.length)
            return board.row[index]
        return null;
    }

    // Returns the row type as one of "close" / "ranged" / "siege"
    getRowType() {
        let idx = this.getRowIndex();
        switch (idx) {
            case 0:
            case 5:
                return "siege";
            case 1:
            case 4:
                return "ranged";
            case 2:
            case 3:
                return "close";
        }
        return "unknown";
    }
}

// Handles how weather effects are added and removed
class Weather extends CardContainer {
    constructor() {
        super();
        this.types = {
            rain: {
                name: "rain",
                count: 0,
                rows: []
            },
            fog: {
                name: "fog",
                count: 0,
                rows: []
            },
            frost: {
                name: "frost",
                count: 0,
                rows: []
            }
        }
        let i = 0;
        for (let key of Object.keys(this.types))
            this.types[key].rows = [board.row[i], board.row[5 - i++]];
    }

    // Adds a card if unique and clears all weather if 'clear weather' card added
    async addCard(card, withEffects = true) {
        super.addCard(card);
        if (!withEffects)
            return;
        if (card.key === "spe_clear") {
            this.clearWeather();
        } else {
            this.changeWeather(card, x => ++this.types[x].count === 1, (r, t) => r.addOverlay(t.name));
            for (let i = this.cards.length - 2; i >= 0; --i) {
                if (card.abilities.at(-1) === this.cards[i].abilities.at(-1)) {
                    await board.toGrave(card, this);
                    break;
                }
            }
        }
    }

    // Override
    removeCard(card, withEffects = true) {
        card = super.removeCard(card);
        if (withEffects)
            this.changeWeather(card, x => --this.types[x].count === 0, (r, t) => r.removeOverlay(t.name));
        return card;
    }

    // Checks if a card's abilities are a weather type. If the predicate is met, perfom the action
    // on the type's associated rows
    changeWeather(card, predicate, action) {
        for (let x of card.abilities) {
            if (x in this.types && predicate(x)) {
                for (let r of this.types[x].rows)
                    action(r, this.types[x]);
            }
        }
    }

    // Removes all weather effects and cards
    async clearWeather() {
        await Promise.all(this.cards.map((c, i) => this.cards[this.cards.length - i - 1]).map(c => board.toGrave(c, this)));
    }

    // Override
    reset() {
        super.reset();
        Object.keys(this.types).map(t => this.types[t].count = 0);
    }
}

// 
class Board {
    constructor() {
        this.op_score = 0;
        this.me_score = 0;
        this.row = [];
        for (let x = 0; x < 6; ++x) {
            this.row[x] = new Row();
        }
    }

    // Get the opponent of this Player
    opponent(player) {
        return player === player_me ? player_op : player_me;
    }

    // Sends and translates a card from the source to the Deck of the card's holder
    async toDeck(card, source) {
        await this.moveTo(card, "deck", source);
    }

    // Sends and translates a card from the source to the Grave of the card's holder
    async toGrave(card, source) {
        await this.moveTo(card, "grave", source);
    }

    // Sends and translates a card from the source to the Hand of the card's holder
    async toHand(card, source) {
        await this.moveTo(card, "hand", source);
    }

    // Sends and translates a card from the source to Weather
    async toWeather(card, source) {
        await this.moveTo(card, weather, source);
    }

    // Sends and translates a card from the source to the Deck of the card's combat row
    async toRow(card, source) {
        let row = (card.row === "agile") ? "close" : card.row ? card.row : "close";
        await this.moveTo(card, row, source);
    }

    // Sends and translates a card from the source to a specified row name or CardContainer
    async moveTo(card, dest, source=null) {
        if (isString(dest)) dest = this.getRow(card, dest);
        if (dest instanceof Row || dest instanceof Weather)
            await dest.addCard(source ? source.removeCard(card) : card);	//Only the override in the Row/Weather classes are asynchronous
        else
            dest.addCard(source ? source.removeCard(card) : card);
    }

    // Sends and translates a card from the source to a specified row name or CardContainer - NO EFFECTS/ABILITIES
    async moveToNoEffects(card, dest, source=null) {
        if (isString(dest)) dest = this.getRow(card, dest);
        if (dest instanceof Row || dest instanceof Weather)
            await dest.addCard(source ? source.removeCard(card, false) : card, false);	//Only the override in the Row/Weather classes are asynchronous
        else
            dest.addCard(source ? source.removeCard(card) : card);
    }

    // Sends and translates a card from the source to a row name associated with the passed player
    async addCardToRow(card, row_name, player, source) {
        let row;
        if (row_name instanceof Row) {
            row = row_name;
        } else {
            row = this.getRow(card, row_name, player);
        }
        await row.addCard(card);
    }

    // Returns the Card associated with the row name that the card would be sent to
    getRow(card, row_name, player) {
        player = player ? player : card ? card.holder : player_me;
        let isMe = player === player_me;
        let isSpy = card.abilities.includes("spy");
        switch (row_name) {
            case "weather":
                return weather;
                break;
            case "close":
                return this.row[isMe ^ isSpy ? 3 : 2];
            case "ranged":
                return this.row[isMe ^ isSpy ? 4 : 1];
            case "siege":
                return this.row[isMe ^ isSpy ? 5 : 0];
            case "grave":
                return player.grave;
            case "deck":
                return player.deck;
            case "hand":
                return player.hand;
            default:
                console.error(card.name + " sent to incorrect row \"" + row_name + "\" by " + card.holder.name);
        }
    }

    // Updates which player currently is in the lead
    updateLeader() {
        let dif = player_me.total - player_op.total;
        player_me.setWinning(dif > 0);
        player_op.setWinning(dif < 0);
    }

    updateScores() {
        //this.row.map(r => r.cards.map(c => r.cardScore(c)));
        this.row.map(r => r.updateScore());
    }
}

class Game {
    constructor() {
        this.reset();
        this.randomOPDeck = true;
        this.fullAI = false;
    }

    reset() {
        this.firstPlayer;
        this.currPlayer = null;

        this.gameStart = [];
        this.roundStart = [];
        this.roundEnd = [];
        this.turnStart = [];
        this.turnEnd = [];

        this.roundCount = 0;
        this.roundHistory = [];
        this.over = false;

        this.randomRespawn = false;
        this.medicCount = 1;
        this.whorshipBoost = 1;
        this.spyPowerMult = 1;
        this.decoyCancelled = false;
        this.scorchCancelled = false;

        // Also resetting some board/row properties affected during the course of a game
        if (board) {
            if (board.row) {
                board.row.forEach(r => {
                    r.halfWeather = false;
                });
            }
        }

        weather.reset();
        board.row.forEach(r => r.reset());
    }

    // Sets up player faction abilities and psasive leader abilities
    initPlayers(p1, p2) {
        let l1 = ability_dict[p1.leader.abilities[0]];
        let l2 = ability_dict[p2.leader.abilities[0]];
        let special_abilities = {
            emhyr_whiteflame: false,
            meve_white_queen: false
        };
        if (l1 === ability_dict["emhyr_whiteflame"] || l2 === ability_dict["emhyr_whiteflame"]) {
            p1.disableLeader();
            p2.disableLeader();
            special_abilities["emhyr_whiteflame"] = true;
        } else {
            initLeader(p1, l1);
            initLeader(p2, l2);
            if (l1 === ability_dict["meve_white_queen"] || l2 === ability_dict["meve_white_queen"])
                special_abilities["meve_white_queen"] = true;
        }
        if (p1.deck.faction === p2.deck.faction && p1.deck.faction === "scoiatael")
            return special_abilities;
        initFaction(p1);
        initFaction(p2);

        function initLeader(player, leader) {
            if (leader.placed)
                leader.placed(player.leader);
            Object.keys(leader).filter(key => game[key]).map(key => game[key].push(leader[key]));
        }

        function initFaction(player) {
            //Only passive faction abilities
            if (factions[player.deck.faction] && factions[player.deck.faction].factionAbility && !factions[player.deck.faction].activeAbility)
                factions[player.deck.faction].factionAbility(player);
        }

        return special_abilities;
    }

    // Sets initializes player abilities, player hands and redraw
    async startGame() {
        this.gameTracker = new GameTracker(player_me, player_op);
        let special_abilities = this.initPlayers(player_me, player_op);
        await Promise.all([...Array(10).keys()].map(async () => {
            await player_me.deck.draw(player_me.hand);
            await player_op.deck.draw(player_op.hand);
        }));

        await this.runEffects(this.gameStart);
        if (!this.firstPlayer)
            this.firstPlayer = await this.coinToss();
        await this.initialRedraw();
        return this.gameTracker;
    }

    // Simulated coin toss to determine who starts game
    async coinToss() {
        this.firstPlayer = (Math.random() < 0.5) ? player_me : player_op;
        return this.firstPlayer;
    }

    // Allows the player to swap out up to two cards from their iniitial hand
    async initialRedraw() {
        for (let i = 0; i < 2; i++) {
            player_op.controller.redraw();
            player_me.controller.redraw();
        }
        await game.startRound();
    }

    // Initiates a new round of the game
    async startRound(verdict = false) {
        this.roundCount++;
        if (verdict && verdict.winner) {
            //Last round winner starts the round
            this.currPlayer = verdict.winner.opponent();
        } else {
            this.currPlayer = (this.roundCount % 2 === 0) ? this.firstPlayer : this.firstPlayer.opponent();
        }
        player_me.roundStartReset();
        player_op.roundStartReset();

        await this.runEffects(this.roundStart);

        board.row.map(r => r.updateScore());

        if (!player_me.canPlay())
            player_me.setPassed(true);
        if (!player_op.canPlay())
            player_op.setPassed(true);

        this.gameTracker.startRound();

        if (player_op.passed && player_me.passed)
            return await this.endRound();

        if (this.currPlayer.passed)
            this.currPlayer = this.currPlayer.opponent();

        await this.startTurn();
    }

    // Starts a new turn. Enables client interraction in client's turn.
    async startTurn() {
        await this.runEffects(this.turnStart);
        if (!this.currPlayer.opponent().passed) {
            this.currPlayer = this.currPlayer.opponent();
        }
        await this.currPlayer.startTurn();
    }

    // Ends the current turn and may end round. Disables client interraction in client's turn.
    async endTurn() {
        await this.runEffects(this.turnEnd);
        board.updateScores();
        this.gameTracker.endTurn();
        if (player_op.passed && player_me.passed) {
            await this.endRound();
        } else {
            await this.startTurn();
        }
    }

    // Ends the round and may end the game. Determines final scores and the round winner.
    async endRound() {
        let dif = player_me.total - player_op.total;
        if (dif === 0) {
            let nilf_me = player_me.deck.faction === "nilfgaard",
                nilf_op = player_op.deck.faction === "nilfgaard";
            dif = nilf_me ^ nilf_op ? nilf_me ? 1 : -1 : 0;
        }
        let winner = dif > 0 ? player_me : dif < 0 ? player_op : null;
        let verdict = {
            winner: winner,
            score_me: player_me.total,
            score_op: player_op.total
        }

        this.roundHistory.push(verdict);

        this.gameTracker.endRound(winner);

        await this.runEffects(this.roundEnd);

        player_me.endRound(dif > 0);
        player_op.endRound(dif < 0);
        if (player_me.health === 0 || player_op.health === 0)
            this.over = true;

        board.row.forEach(row => row.clear());
        weather.clearWeather();

        if (dif > 0) {
        } else if (dif < 0) {
            if (nilfgaard_wins_draws) {
                nilfgaard_wins_draws = false;
            }
        }

        if (player_me.health === 0 || player_op.health === 0)
            await this.endGame();
        else
            await this.startRound(verdict);
    }

    // Sets up and displays the end-game screen
    async endGame() {
        
        if (player_op.health <= 0 && player_me.health <= 0) {
            this.gameTracker.endGame(null);
        } else if (player_op.health === 0) {
            this.gameTracker.endGame(player_me);
        } else {
            this.gameTracker.endGame(player_op);
        }
    }

    // Returns the client to the deck customization screen
    returnToCustomization() {
        this.reset();
        player_me.reset();
        player_op.reset();
    }

    // Restarts the last game with the same decks
    async restartGame() {
        this.reset();
        player_me.reset();
        player_op.reset();
        await this.startGame();
        return this.gameTracker;
    }

    // Executes effects in list. If effect returns true, effect is removed.
    async runEffects(effects) {
        for (let i = effects.length - 1; i >= 0; --i) {
            let effect = effects[i];
            if (await effect())
                effects.splice(i, 1)
        }
    }

}

// Contians information and behavior of a Card
class Card {

    constructor(key, card_data, player) {
        if (!card_data) {
            console.log("Invalid card data for: " + key);
        }
        this.id;
        if (card_data.id)
            this.id = Number(card_data.id);
        this.key = key;
        this.name = card_data.name;
        this.basePower = this.power = Number(card_data.strength);
        this.faction = card_data.deck;
        // To clean the field in case it is a faction specific weather/special card
        if (this.faction.startsWith("weather") || this.faction.startsWith("special")) {
            this.faction = this.faction.split(" ")[0];
        }
        this.abilities = (card_data.ability === "") ? [] : card_data.ability.split(" ");
        this.row = (this.faction === "weather") ? this.faction : card_data.row;
        this.filename = card_data.filename;
        this.placed = [];
        this.removed = [];
        this.activated = [];
        this.holder = player;
        this.locked = false;
        this.decoyTarget = false;
        this.target = "";
        this.currentLocation = board;	// By default, updated later
        if ("target" in card_data) {
            this.target = card_data.target;
        }
        this.quote = "";
        if ("quote" in card_data) {
            this.quote = card_data.quote;
        }

        this.hero = false;
        if (this.abilities.length > 0) {
            if (this.abilities[0] === "hero") {
                this.hero = true;
                this.abilities.splice(0, 1);
            }
            for (let x of this.abilities) {
                let ab = ability_dict[x];
                if ("placed" in ab) this.placed.push(ab.placed);
                if ("removed" in ab) this.removed.push(ab.removed);
                if ("activated" in ab) this.activated.push(ab.activated);
            }
        }
    }

    // Returns the identifier for this type of card
    getId() {
        return this.key;
    }

    // Sets and displays the current power of this card
    setPower(n) {
        if (this.key === "spe_decoy")
            return;
        if (n !== this.power) {
            this.power = n;
        }
    }

    // Resets the power of this card to default
    resetPower() {
        this.setPower(this.basePower);
    }

    // Automatically sends and translates this card to its apropriate row from the passed source
    async autoplay(source) {
        await board.toRow(this, source);
    }

    // Animates an ability effect
    async animate(name, bFade = true, bExpand = true) {

    }

    // Animates the scorch effect
    async scorch(name) {

    }

    // Returns true if this is a combat card that is not a Hero
    isUnit() {
        return !this.hero && (this.row === "close" || this.row === "ranged" || this.row === "siege" || this.row === "agile");
    }

    // Returns true if card is sent to a Row's special slot
    isSpecial() {
        return ["spe_horn", "spe_mardroeme", "spe_sign_quen", "spe_sign_yrden", "spe_toussaint_wine", "spe_lyria_rivia_morale", "spe_wyvern_shield", "spe_mantlet", "spe_garrison", "spe_dimeritium_shackles"].includes(this.key);
    }

    // Compares by type then power then name
    static compare(a, b) {
        let dif = factionRank(a) - factionRank(b);
        if (dif !== 0)
            return dif;
        // Muster/Bond cards
        if (a.target && b.target && a.target === b.target) {
            if (a.id && b.id)
                return Number(a.id) - Number(b.id);
            if (a.key && b.key)
                return a.key.localeCompare(b.key);
        }
        dif = a.basePower - b.basePower;
        if (dif && dif !== 0)
            return dif;

        return a.name.localeCompare(b.name);

        function factionRank(c) {
            return c.faction === "special" ? -2 : (c.faction === "weather") ? -1 : 0;
        }
    }

    // Indicates whether or not the abilities of this card are locked
    isLocked() {
        return this.locked;
    }
}

// Handles notifications and client interration with menus
class UI {
    constructor() {
        this.previewCard = null;
        this.lastRow = null;
    }


    // Enables or disables client interration
    enablePlayer(enable) {

    }


    // Called when the player selects a selectable card
    async selectCard(card) {
        let row = this.lastRow;
        let pCard = this.previewCard;
        if (card === pCard)
            return;
        if (pCard === null || card.holder.hand.cards.includes(card)) {
            this.showPreview(card);
        } else if (pCard.abilities.includes("decoy")) {
            this.hidePreview(card);
            card.decoyTarget = true;
            board.toHand(card, row);
            await board.moveTo(pCard, row, pCard.holder.hand);
            await pCard.holder.endTurn();
        } else if (pCard.abilities.includes("alzur_maker")) {
            this.hidePreview(card);
            await board.toGrave(card, row);
            let target = new Card(ability_dict["alzur_maker"].target, card_dict[ability_dict["alzur_maker"].target], card.holder);
            await board.addCardToRow(target, target.row, card.holder);
            await pCard.holder.endTurn();
        }
    }

    // Called when the player selects a selectable CardContainer
    async selectRow(row, isSpecial = false) {
        this.lastRow = row;
        if (this.previewCard === null) {
            return;
        }
        if (this.previewCard.key === "spe_decoy" || this.previewCard.abilities.includes("alzur_maker"))
            return;
        if (this.previewCard.abilities.includes("decoy") && row.cards.filter(c => c.isUnit()).length > 0)
            return;	// If a unit can be selected, we cannot select the whole row
        let card = this.previewCard;
        let holder = card.holder;
        this.hidePreview();
        if (card.faction === "special" && card.abilities.includes("scorch")) {
            this.hidePreview();
            if (!game.scorchCancelled)
                await ability_dict["scorch"].activated(card);
        } else if (card.faction === "special" && card.abilities.includes("cintra_slaughter")) {
            this.hidePreview();
            await ability_dict["cintra_slaughter"].activated(card);
        } else if (card.faction === "special" && card.abilities.includes("seize")) {
            this.hidePreview();
            await ability_dict[card.abilities.at(-1)].activated(card);
        } else if (card.faction === "special" && card.abilities.includes("knockback")) {
            this.hidePreview();
            await ability_dict[card.abilities.at(-1)].activated(card, row);
        } else if (card.key === "spe_decoy" || card.abilities.includes("alzur_maker")) {
            return;
        } else if (card.abilities.includes("decoy") && row.cards.filter(c => c.isUnit()).length > 0) {
            return;	// If a unit can be selected, we cannot select the whole row
        } else if (card.abilities.includes("anna_henrietta_duchess")) {
            this.hidePreview(card);
            let horn = row.special.cards.filter(c => c.abilities.includes("horn"))[0];
            if (horn)
                await board.toGrave(horn, row);
        } else if (card.key === "spe_lyria_rivia_morale") {
            await board.moveTo(card, row);
        } else if (card.abilities.includes("meve_princess") || card.abilities.includes("carlo_varese")) {
            this.hidePreview(card);
            if (!game.scorchCancelled)
                await row.scorch();
        } else if (card.abilities.includes("cyrus_hemmelfart")) {
            this.hidePreview(card);
            let new_card = new Card("spe_dimeritium_shackles", card_dict["spe_dimeritium_shackles"], card.holder);
            await board.moveTo(new_card, row);
        } else if (card.faction === "special" && card.abilities.includes("bank")) {
            this.hidePreview();
            await ability_dict["bank"].activated(card);
        } else {
            await board.moveTo(card, row, card.holder.hand);
        }
        await holder.endTurn();
    }

    // Called when the client cancels out of a card-preview
    cancel() {
        this.hidePreview();
    }

    // Displays a card preview then enables and highlights potential card destinations
    showPreview(card) {
        this.showPreviewVisuals(card);
    }

    // Sets up the graphics and description for a card preview
    showPreviewVisuals(card) {
        this.previewCard = card;
    }

    // Hides the card preview then disables and removes highlighting from card destinations
    hidePreview() {
        this.previewCard = null;
        this.lastRow = null;
    }

    // Displayed a timed notification to the client
    async notification(name, duration) {

    }

    async queueCarousel(container, count, action, predicate, bSort, bQuit, title) {

    }

}

// Screen used to customize, import and export deck contents
class DeckMaker {
    constructor() {
        this.start_me_deck;
        this.start_op_deck;
        this.me_deck_index = 0;
        this.op_deck_index = 0;
    }


    // Verifies current deck, creates the players and their decks, then starts a new game
    async startNewGame(deck1, deck2) {
        this.selectDeck(deck1);
        this.selectOPDeck(deck2);

        player_me = new Player(0, "Player 1", this.start_me_deck, true);
        player_op = new Player(1, "Player 2", this.start_op_deck, true);
        if (game.gameTracker)
            return await game.restartGame();
        return await game.startGame();
    }

    // Select a premade deck
    selectDeck(deck) {
        this.start_me_deck = JSON.parse(JSON.stringify(deck));
        this.start_me_deck.cards = this.start_me_deck.cards.map(c => ({
            index: c[0],
            count: c[1]
        }));
        this.start_me_deck.leader = { index: this.start_me_deck.leader, card: card_dict[this.start_me_deck.leader] };
    }

    selectOPDeck(deck) {
        //this.start_op_deck = JSON.parse(JSON.stringify(premade_deck[i - 1]));
        this.start_op_deck = JSON.parse(JSON.stringify(deck));
        this.start_op_deck.cards = this.start_op_deck.cards.map(c => ({
            index: c[0],
            count: c[1]
        }));
        this.start_op_deck.leader = { index: this.start_op_deck.leader, card: card_dict[this.start_op_deck.leader] };
    }
}

// Returns true if n is an Number
function isNumber(n) {
    return !isNaN(parseFloat(n)) && isFinite(n);
}

// Returns true if s is a String
function isString(s) {
    return typeof (s) === 'string' || s instanceof String;
}

// Returns a random integer in the range [0,n)
function randomInt(n) {
    return Math.floor(Math.random() * n);
}

// Pauses execution until the passed number of milliseconds as expired
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Suspends execution until the predicate condition is met, checking every ms milliseconds
function sleepUntil(predicate, ms) {
    return new Promise(resolve => {
        let timer = setInterval(function () {
            if (predicate()) {
                clearInterval(timer);
                resolve();
            }
        }, ms)
    });
}

function tocar() {

}

/*----------------------------------------------------*/
function setTimeout(callback, time) {
    try {
        callback();
    } catch (e) { }
}

function simulateGame() {

}
/*----------------------------------------------------*/

var ui = new UI();
var board = new Board();
var weather = new Weather();
var game = new Game();
var player_me, player_op;

let dm = new DeckMaker();

window.onload = function () {
    // Init decks list
    for (var i = 0; i < premade_deck.length; i++) {
        let el1 = document.createElement("option");
        el1.setAttribute("value",String(i));
        el1.innerText = premade_deck[i]["title"];
        document.getElementById("deck-1").appendChild(el1);

        let el2 = document.createElement("option");
        el2.setAttribute("value",String(i));
        el2.innerText = premade_deck[i]["title"];
        document.getElementById("deck-2").appendChild(el2);
    }

    document.getElementById("launch").addEventListener("click", async function () {
        let d1 = document.getElementById("deck-1").value;
        let d2 = document.getElementById("deck-2").value;
        let nbSims = parseInt(document.getElementById("nb-sims").value);

        let res_list = [];
        let stats = { "me": 0, "op": 0, "draw": 0 };
        let abStats = {};
        for (var i = 0; i < nbSims; i++) {
            res_list.push(await dm.startNewGame(premade_deck[d1], premade_deck[d2]));
            let res = res_list.at(-1);
            let resElem = document.createElement("div");
            if (res.winner) {
                stats[res.winner.tag]++;
                resElem.innerHTML = `(${res.player1.deck_data.title} vs ${res.player2.deck_data.title}) Winner: Player "${res.winner.tag}" - Scores: ${res.getScores()}`;
            } else { 
                stats["draw"]++;
                resElem.innerHTML = `(${res.player1.deck_data.title} vs ${res.player2.deck_data.title}) Draw - Scores: ${res.getScores()}`;
            }
            document.getElementById("sim-results").appendChild(resElem);
            if (i === 0) {
                res.rounds.forEach(r => {
                    r.turns.forEach(t => {
                        console.log(t.summary());
                    });
                });
                console.log(res);
                
                //console.log(res.getCardImpacts());
            }
            let imp_stats = res.getAbilitiesImpact();
            Object.keys(imp_stats).forEach(key => {
                if (!abStats[key])
                    abStats[key] = [];
                abStats[key] = abStats[key].concat(imp_stats[key]);
            });
        }
        let resElem = document.createElement("div");
        resElem.innerHTML = `<b>Total: Player 1: ${stats["me"]} wins (${100 * (stats["me"] / nbSims)}%) - Player 2: ${stats["op"]} wins (${100 * (stats["op"] / nbSims)}%) - Draws: ${stats["draw"]}</b>`
        document.getElementById("sim-results").appendChild(resElem);

        Object.keys(abStats).forEach(key => {
            if (abStats[key].length > 0)
                console.log(key + " => " + (abStats[key].reduce((a, b) => a + b) / abStats[key].length));
        });

        /*res.rounds.forEach(r => {
            r.turns.forEach(t => {
                console.log(t.summary());
            });
        });*/
        //console.log(res);
    });

    document.getElementById("launch-all").addEventListener("click", async function () {
        let nbSims = parseInt(document.getElementById("nb-sims").value);

        let stats = [];
        let deck_stats = [];
        let abStats = {};
        for (var d1 = 0; d1 < premade_deck.length; d1++) {
            let row_stats = [];
            for (var d2 = 0; d2 < premade_deck.length; d2++) {
                let curr_stats = { "me": 0, "op": 0, "draw": 0 };
                for (var i = 0; i < nbSims; i++) {
                    console.log(premade_deck[d1]["title"] + " vs " + premade_deck[d2]["title"]);
                    let res = await dm.startNewGame(premade_deck[d1], premade_deck[d2])
                    try {
                        if (res.winner) {
                            curr_stats[res.winner.tag]++;
                        } else {
                            curr_stats["draw"]++;
                        }
                        let imp_stats = res.getAbilitiesImpact();
                        Object.keys(imp_stats).forEach(key => {
                            if (!abStats[key])
                                abStats[key] = [];
                            abStats[key] = abStats[key].concat(imp_stats[key]);
                        });
                    } catch (e) {
                        console.log(e);
                    }
                }
                row_stats.push(curr_stats);
            }
            stats.push(row_stats);
        }

        let table = document.createElement("table");
        table.setAttribute("id", "all-table-results");
        let row = document.createElement("tr");

        // Corner cell
        let th = document.createElement("th");
        th.innerText = "/";
        row.appendChild(th);
        for (var i = 0; i < premade_deck.length; i++) {
            let th = document.createElement("th");
            th.innerText = premade_deck[i]["title"];
            deck_stats.push(0);
            row.appendChild(th);
        }
        table.appendChild(row);
        for (var i = 0; i < premade_deck.length; i++) {
            row = document.createElement("tr");
            // Deck name
            let td = document.createElement("td");
            td.innerText = premade_deck[i]["title"];
            row.appendChild(td);
            for (var j = 0; j < premade_deck.length; j++) {
                let td = document.createElement("td");
                let st = stats[i][j];
                td.innerText = `${st["me"]} wins (${100 * (st["me"] / nbSims)}%)`;
                deck_stats[i] += st["me"];
                deck_stats[j] += st["op"];
                row.appendChild(td);
            }
            table.appendChild(row);
        }
        row = document.createElement("tr");
        let td = document.createElement("td");
        td.innerText = "TOTAL";
        row.appendChild(td);
        for (var i = 0; i < premade_deck.length; i++) {
            let th = document.createElement("th");
            th.innerText = `${deck_stats[i]} wins (${100 * (deck_stats[i] / (2 * nbSims * premade_deck.length - nbSims))}%)`;
            row.appendChild(th);
        }
        table.appendChild(row);
        document.getElementById("sim-results").appendChild(table);

        Object.keys(abStats).forEach(key => {
            if (abStats[key].length > 0)
                console.log(key + " => " + (abStats[key].reduce((a, b) => a + b) / abStats[key].length));
        });

    });
}
