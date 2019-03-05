function Person(name, foods) {
    this.name = name;
    this.foods = foods;
}

Person.prototype.fetchFavFoods = function() {

    new Promise((resolve, reject) => {
        //simulate an API
        setTimeout(() => resolve(this.foods), 2000);
    });
};

describe("mocking learning", () => {
  it("mocks a reg function", () => {
    const fetchDogs = jest.fn();
    fetchDogs('snickers');
    expect(fetchDogs).toHaveBeenCalled();
    expect(fetchDogs).toHaveBeenCalledWith('snickers');

    // fetchDogs('hugo');
    expect(fetchDogs).toHaveBeenCalledTimes(2); //expected fail
  });

  it('can create a person', () => {
    const me = new Person('Thongvun', ['pho', 'burgs']);
    expect(me.name).toBe('Thongvun');
  });

  it('can fetch foods', async () => {
    const me = new Person('Thongvun', ['pho', 'burgs']);
    const favFoods = await me.fetchFavFoods();
    console.log(favFoods);
    expect(favFoods).toContain('pho');
  });


});
